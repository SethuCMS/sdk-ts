/**
 * The request pipeline: authentication, timeouts, retries and error handling.
 */
import { SethuApiError, errorFromResponse } from './errors.js';

export type TokenSource = string | (() => string | Promise<string>);

export interface ClientOptions {
  /** Address of the gateway, for example "https://cms.example.com". Must be https (http only for localhost). */
  baseUrl: string;
  /** Bearer token, or a function that returns one (called for every request, so it can refresh). */
  token?: TokenSource;
  /** Replace the global `fetch`, for tests or special runtimes. */
  fetch?: typeof fetch;
  /** Give up on a request after this many milliseconds. Default 30000. */
  timeoutMs?: number;
  /** How many times to retry a failed read. Writes are never retried. Default 2. */
  maxRetries?: number;
  /** Allow plain http to a non-local address. Off by default; tokens would travel unencrypted. */
  allowInsecureHttp?: boolean;
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path below the base URL, already encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export function normalizeBaseUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('baseUrl must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('baseUrl must use https');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname) && !allowInsecureHttp) {
    throw new TypeError('baseUrl must use https. Plain http is only allowed for localhost.');
  }
  if (url.username || url.password) throw new TypeError('baseUrl must not contain credentials. Pass a token instead.');
  return url.toString().replace(/\/+$/, '');
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly token: TokenSource | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureHttp ?? false);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async request<T>(spec: RequestSpec): Promise<T> {
    const canRetry = spec.method === 'GET';
    const attempts = canRetry ? this.maxRetries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send<T>(spec);
      } catch (error) {
        const last = attempt >= attempts;
        if (last || !isRetryable(error)) throw error;
        await sleep(backoffMs(attempt, error), spec.signal);
      }
    }
  }

  private async send<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (token) headers['Authorization'] = `Bearer ${token}`; // sent in a header, never in the URL
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.idempotencyKey) headers['Idempotency-Key'] = spec.idempotencyKey;

    // One timer covers the whole exchange, including reading the body. It is always cleared.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = spec.signal ? AbortSignal.any([spec.signal, timeoutController.signal]) : timeoutController.signal;

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          signal,
          ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
          credentials: 'omit',
        });
      } catch (error) {
        throw this.explainFailure(error, spec, timeoutController.signal);
      }

      let body: unknown;
      try {
        body = await readJson(response);
      } catch (error) {
        throw this.explainFailure(error, spec, timeoutController.signal);
      }
      if (!response.ok) {
        const error = errorFromResponse(response.status, body);
        const retryAfter = Number(response.headers.get('Retry-After'));
        throw Object.assign(error, Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {});
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private explainFailure(error: unknown, spec: RequestSpec, timeout: AbortSignal): unknown {
    if (spec.signal?.aborted) return error; // the caller cancelled; pass that through unchanged
    if (timeout.aborted) return new SethuApiError('TIMEOUT', 'The request took too long', { status: 0, cause: error });
    return new SethuApiError('CONNECTION_FAILED', 'Could not reach the server', { status: 0, cause: error });
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON (for example an HTML error page); callers handle the missing body
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof SethuApiError)) return false;
  return error.status === 0 ? error.code === 'CONNECTION_FAILED' : RETRYABLE_STATUS.has(error.status);
}

function backoffMs(attempt: number, error: unknown): number {
  const hinted = (error as { retryAfterMs?: number }).retryAfterMs;
  if (hinted !== undefined) return Math.min(hinted, 10_000);
  return Math.min(200 * 2 ** (attempt - 1), 5_000) * (0.5 + Math.random() / 2);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
