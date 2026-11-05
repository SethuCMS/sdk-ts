import type { Filter } from './filters.js';
import { and } from './filters.js';
import type { HttpClient } from './http.js';

export type RecordData = Record<string, unknown>;

export interface ListResult<T = RecordData> {
  data: T[];
  /** Pass to `after()` to get the next page. Null on the last page. */
  nextCursor: string | null;
  limit: number;
  /** Notes from the server, for example "sorting needs an index". */
  notes: string[];
}

interface ListResponse<T> {
  data: T[];
  page: { nextCursor: string | null; limit: number };
  meta?: { capabilityNotes?: string[] };
}

/** How many records match. `exact` is false when counting stopped at the limit ("at least"). */
export interface CountResult {
  count: number;
  exact: boolean;
}

/** An unpublished edit, kept by the gateway until it is published. */
export interface Draft {
  id: string;
  /** The record this draft changes, or null when it will create a new one. */
  recordId: string | null;
  values: RecordData;
  /** Send this back when saving or publishing, so a stale change is refused. */
  version: number;
  status: 'draft' | 'publishing' | 'published' | 'discarded';
  createdAt: string;
  updatedAt: string;
  /** When a scheduled publish will happen (UTC, ISO text). Set only while one is waiting. */
  publishAt?: string;
  /** Why the last scheduled publish did not happen. The schedule is cleared when this is set. */
  scheduleError?: string;
}

interface RecordResponse<T> {
  data: T;
}

export interface WriteOptions {
  /** Makes retries of the same write safe. A random key is generated when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** One collection of one connection. Create it with `client.collection(connectionId, name)`. */
export class Collection<T extends RecordData = RecordData> {
  constructor(
    private readonly http: HttpClient,
    private readonly connectionId: string,
    private readonly name: string,
  ) {}

  private get base(): string {
    return `/v1/connections/${encodeURIComponent(this.connectionId)}/collections/${encodeURIComponent(this.name)}/records`;
  }

  /**
   * Drafts of this collection: edits that are not in the database until published.
   *
   *   const draft = await orders.drafts.create({ recordId: 7, values: { status: 'paid' } });
   *   await orders.drafts.schedule(draft.id, new Date('2026-12-01T09:00:00+05:30'));
   */
  get drafts(): Drafts {
    return new Drafts(this.http, this.connectionId, this.name);
  }

  /** Start building a query. */
  query(): QueryBuilder<T> {
    return QueryBuilder.create<T>(this);
  }

  /** Shortcut for `query().where(filter)`. */
  where(filter: Filter): QueryBuilder<T> {
    return this.query().where(filter);
  }

  async get(id: string | number, options: { signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.http.request<RecordResponse<T>>({ method: 'GET', path: `${this.base}/${encodeURIComponent(String(id))}`, ...options });
    return response.data;
  }

  async create(values: Partial<T>, options: WriteOptions = {}): Promise<T> {
    const response = await this.http.request<RecordResponse<T>>({
      method: 'POST',
      path: this.base,
      body: values,
      idempotencyKey: options.idempotencyKey ?? newKey(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }

  async update(id: string | number, values: Partial<T>, options: WriteOptions = {}): Promise<T> {
    const response = await this.http.request<RecordResponse<T>>({
      method: 'PATCH',
      path: `${this.base}/${encodeURIComponent(String(id))}`,
      body: values,
      idempotencyKey: options.idempotencyKey ?? newKey(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }

  async delete(id: string | number, options: WriteOptions = {}): Promise<void> {
    await this.http.request<void>({
      method: 'DELETE',
      path: `${this.base}/${encodeURIComponent(String(id))}`,
      idempotencyKey: options.idempotencyKey ?? newKey(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * Count the records you may see. Capped (default 1000, at most 10000), so a huge table answers
   * `{ count: 1000, exact: false }` quickly instead of being walked.
   */
  count(options: { max?: number; signal?: AbortSignal } = {}): Promise<CountResult> {
    return this.runCount([], options.max, options.signal);
  }

  /** @internal Used by Collection.count and QueryBuilder.count. */
  async runCount(filters: Filter[], max?: number, signal?: AbortSignal): Promise<CountResult> {
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new RangeError('max must be a whole number of at least 1');
    const response = await this.http.request<RecordResponse<CountResult>>({
      method: 'GET',
      path: this.base.replace(/\/records$/, '/count'),
      query: {
        filter: filters.length === 0 ? undefined : JSON.stringify(filters.length === 1 ? filters[0] : and(...filters)),
        max: max === undefined ? undefined : String(max),
      },
      ...(signal ? { signal } : {}),
    });
    return response.data;
  }

  /** @internal Used by QueryBuilder. */
  async runList(state: QueryState, signal?: AbortSignal): Promise<ListResult<T>> {
    const response = await this.http.request<ListResponse<T>>({
      method: 'GET',
      path: this.base,
      query: {
        filter: state.filters.length === 0 ? undefined : JSON.stringify(state.filters.length === 1 ? state.filters[0] : and(...state.filters)),
        sort: state.sorts.length === 0 ? undefined : state.sorts.map((s) => (s.dir === 'desc' ? `-${s.field}` : s.field)).join(','),
        fields: state.fields.length === 0 ? undefined : state.fields.join(','),
        limit: state.limit === undefined ? undefined : String(state.limit),
        cursor: state.cursor ?? undefined,
      },
      ...(signal ? { signal } : {}),
    });
    return {
      data: response.data,
      nextCursor: response.page.nextCursor ?? null,
      limit: response.page.limit,
      notes: response.meta?.capabilityNotes ?? [],
    };
  }
}

interface QueryState {
  filters: Filter[];
  sorts: Array<{ field: string; dir: 'asc' | 'desc' }>;
  fields: string[];
  limit?: number;
  cursor?: string | null;
}

/** A query under construction. Every method returns a new builder, so builders can be reused safely. */
export class QueryBuilder<T extends RecordData = RecordData> {
  private constructor(
    private readonly collection: Collection<T>,
    private readonly state: QueryState,
  ) {}

  static create<T extends RecordData>(collection: Collection<T>): QueryBuilder<T> {
    return new QueryBuilder<T>(collection, { filters: [], sorts: [], fields: [] });
  }

  private with(change: Partial<QueryState>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.collection, { ...this.state, ...change });
  }

  /** Add a filter. Calling this more than once means "all of these must match". */
  where(filter: Filter): QueryBuilder<T> {
    return this.with({ filters: [...this.state.filters, filter] });
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): QueryBuilder<T> {
    return this.with({ sorts: [...this.state.sorts, { field, dir: direction }] });
  }

  /** Return only these fields. */
  select(...fields: string[]): QueryBuilder<T> {
    return this.with({ fields: [...this.state.fields, ...fields] });
  }

  limit(count: number): QueryBuilder<T> {
    if (!Number.isInteger(count) || count < 1) throw new RangeError('limit must be a whole number of at least 1');
    return this.with({ limit: count });
  }

  /** Continue after a previous page. */
  after(cursor: string | null): QueryBuilder<T> {
    return this.with({ cursor });
  }

  /** Count the matching records (capped; see `Collection.count`). */
  count(options: { max?: number; signal?: AbortSignal } = {}): Promise<CountResult> {
    return this.collection.runCount(this.state.filters, options.max, options.signal);
  }

  /** Fetch one page. */
  list(options: { signal?: AbortSignal } = {}): Promise<ListResult<T>> {
    return this.collection.runList(this.state, options.signal);
  }

  /** The first matching record, or null. */
  async first(options: { signal?: AbortSignal } = {}): Promise<T | null> {
    const page = await this.limit(1).list(options);
    return page.data[0] ?? null;
  }

  /**
   * Walk every matching record, page after page:
   *
   *   for await (const order of orders.where(eq('status', 'paid')).iterate()) { ... }
   */
  async *iterate(options: { signal?: AbortSignal; maxPages?: number } = {}): AsyncGenerator<T, void, void> {
    let builder: QueryBuilder<T> = this;
    const maxPages = options.maxPages ?? 10_000;
    for (let page = 0; page < maxPages; page++) {
      const result = await builder.list(options);
      yield* result.data;
      if (!result.nextCursor) return;
      builder = builder.after(result.nextCursor);
    }
    throw new RangeError(`Stopped after ${maxPages} pages. Raise maxPages if this is expected.`);
  }
}

/** Draft actions for one collection. Get it with `collection.drafts`. */
export class Drafts {
  constructor(
    private readonly http: HttpClient,
    private readonly connectionId: string,
    private readonly name: string,
  ) {}

  private get base(): string {
    return `/v1/connections/${encodeURIComponent(this.connectionId)}/collections/${encodeURIComponent(this.name)}/drafts`;
  }

  private one(draftId: string): string {
    return `${this.base}/${encodeURIComponent(draftId)}`;
  }

  /** Start a draft: pass `recordId` to change a record, or leave it out to draft a new one. */
  async create(input: { recordId?: string | number; values?: RecordData }, options: WriteOptions = {}): Promise<Draft> {
    const response = await this.http.request<RecordResponse<Draft>>({
      method: 'POST',
      path: this.base,
      body: {
        ...(input.recordId === undefined ? {} : { recordId: String(input.recordId) }),
        values: input.values ?? {},
      },
      idempotencyKey: options.idempotencyKey ?? newKey(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }

  /**
   * Publish this draft by itself at a later time, with the latest saved values and your permissions.
   * Pass a Date, or text that includes its time zone (`2026-12-01T09:00:00+05:30` or ending in `Z`).
   * The time must be in the future and at most 366 days ahead. A gateway that runs serverless refuses
   * (`CAPABILITY_UNSUPPORTED`). If publishing fails later, nothing is published and the draft's
   * `scheduleError` says why; it is never retried.
   */
  async schedule(draftId: string, publishAt: Date | string, options: { signal?: AbortSignal } = {}): Promise<Draft> {
    const when = publishAt instanceof Date ? publishAt : null;
    if (when && Number.isNaN(when.getTime())) throw new RangeError('publishAt is not a valid Date');
    const response = await this.http.request<RecordResponse<Draft>>({
      method: 'PUT',
      path: `${this.one(draftId)}/schedule`,
      body: { publishAt: when ? when.toISOString() : publishAt },
      ...options,
    });
    return response.data;
  }

  /** Cancel a scheduled publish, or clear the note about a failed one. */
  async cancelSchedule(draftId: string, options: { signal?: AbortSignal } = {}): Promise<Draft> {
    const response = await this.http.request<RecordResponse<Draft>>({ method: 'DELETE', path: `${this.one(draftId)}/schedule`, ...options });
    return response.data;
  }

  /** Write the draft to the database now. Pass the draft's `version` so a stale draft is refused. */
  async publish(draftId: string, input: { version: number; force?: boolean }, options: WriteOptions = {}): Promise<{ draft: Draft; record: RecordData }> {
    const response = await this.http.request<RecordResponse<{ draft: Draft; record: RecordData }>>({
      method: 'POST',
      path: `${this.one(draftId)}/publish`,
      body: input,
      idempotencyKey: options.idempotencyKey ?? newKey(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}
