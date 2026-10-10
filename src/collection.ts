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

function newKey(): string {
  return globalThis.crypto.randomUUID();
}
