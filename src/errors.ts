/** Error codes the API can return. They match the platform's error vocabulary. */
export type ErrorCode =
  | 'CONNECTION_FAILED' | 'AUTH_FAILED' | 'FORBIDDEN' | 'READ_ONLY' | 'NOT_FOUND' | 'CONFLICT'
  | 'VALIDATION_FAILED' | 'CAPABILITY_UNSUPPORTED' | 'RATE_LIMITED' | 'TIMEOUT' | 'INTERNAL';

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_FAILED', 'AUTH_FAILED', 'FORBIDDEN', 'READ_ONLY', 'NOT_FOUND', 'CONFLICT',
  'VALIDATION_FAILED', 'CAPABILITY_UNSUPPORTED', 'RATE_LIMITED', 'TIMEOUT', 'INTERNAL',
]);

/** Thrown for every failed API call. Check `code` to decide what to do. */
export class SethuApiError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly details: unknown;
  /** Quote this when asking for support. */
  readonly requestId: string | undefined;

  constructor(code: ErrorCode, message: string, options: { status: number; details?: unknown; requestId?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SethuApiError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export const isSethuApiError = (value: unknown): value is SethuApiError => value instanceof SethuApiError;

function codeFromStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'CONNECTION_FAILED';
  if (status === 504) return 'TIMEOUT';
  return 'INTERNAL';
}

/** Build an error from a failed response body. Never repeats the raw body, which could be an HTML error page. */
export function errorFromResponse(status: number, body: unknown): SethuApiError {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error === 'object' && error !== null) {
    const { code, message, details, requestId } = error as Record<string, unknown>;
    return new SethuApiError(typeof code === 'string' && KNOWN_CODES.has(code) ? (code as ErrorCode) : codeFromStatus(status), typeof message === 'string' ? message : 'Request failed', {
      status,
      details,
      ...(typeof requestId === 'string' ? { requestId } : {}),
    });
  }
  return new SethuApiError(codeFromStatus(status), `The server answered with status ${status}`, { status });
}
