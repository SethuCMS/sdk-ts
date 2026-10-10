import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SethuClient, SethuApiError, and, eq, gt, isSethuApiError } from '../src/index.js';

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A scripted fetch that records what it was asked and answers from a queue. */
function fakeFetch(answers: Array<Response | Error | ((seen: Seen) => Response)>) {
  const seen: Seen[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const entry: Seen = {
      url: new URL(String(input)),
      method: String(init.method),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(entry);
    const next = answers.shift();
    if (!next) throw new Error('no scripted answer left');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(entry) : next;
  }) as typeof fetch;
  return { fn, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const base = { baseUrl: 'https://cms.example.com', token: 'tok_123' };

test('list: builds the request from the query and reads the page', async () => {
  const { fn, seen } = fakeFetch([json({ data: [{ id: 1 }], page: { nextCursor: 'abc', limit: 20 }, meta: { capabilityNotes: ['note'] } })]);
  const orders = new SethuClient({ ...base, fetch: fn }).collection('c 1', 'orders');

  const page = await orders.where(eq('status', 'paid')).where(gt('total', 5)).orderBy('created_at', 'desc').orderBy('id').select('id', 'status').limit(20).list();

  const request = seen[0]!;
  assert.equal(request.url.pathname, '/v1/connections/c%201/collections/orders/records');
  assert.equal(request.url.searchParams.get('sort'), '-created_at,id');
  assert.equal(request.url.searchParams.get('fields'), 'id,status');
  assert.equal(request.url.searchParams.get('limit'), '20');
  assert.deepEqual(JSON.parse(request.url.searchParams.get('filter')!), and(eq('status', 'paid'), gt('total', 5)));
  assert.deepEqual(page, { data: [{ id: 1 }], nextCursor: 'abc', limit: 20, notes: ['note'] });
});

test('a single filter is sent as is, and no filter sends none', async () => {
  const { fn, seen } = fakeFetch([json({ data: [], page: { nextCursor: null, limit: 50 } }), json({ data: [], page: { nextCursor: null, limit: 50 } })]);
  const c = new SethuClient({ ...base, fetch: fn }).collection('c', 'x');
  await c.where(eq('a', 1)).list();
  await c.query().list();
  assert.deepEqual(JSON.parse(seen[0]!.url.searchParams.get('filter')!), eq('a', 1));
  assert.equal(seen[1]!.url.searchParams.has('filter'), false);
});

test('the token is sent in a header, never in the URL', async () => {
  const { fn, seen } = fakeFetch([json({ data: { id: 1 } })]);
  await new SethuClient({ ...base, fetch: fn }).collection('c', 'x').get(1);
  assert.equal(seen[0]!.headers['Authorization'], 'Bearer tok_123');
  assert.ok(!seen[0]!.url.toString().includes('tok_123'));
});

test('a token function is asked for on every request', async () => {
  let n = 0;
  const { fn, seen } = fakeFetch([json({ data: {} }), json({ data: {} })]);
  const c = new SethuClient({ baseUrl: base.baseUrl, token: () => `t${++n}`, fetch: fn }).collection('c', 'x');
  await c.get(1);
  await c.get(2);
  assert.deepEqual(seen.map((s) => s.headers['Authorization']), ['Bearer t1', 'Bearer t2']);
});

test('writes: correct verbs and bodies, and an idempotency key', async () => {
  const { fn, seen } = fakeFetch([json({ data: { id: 1 } }, 201), json({ data: { id: 1 } }), new Response(null, { status: 204 })]);
  const c = new SethuClient({ ...base, fetch: fn }).collection('c', 'x');

  await c.create({ title: 'a' });
  await c.update(1, { title: 'b' }, { idempotencyKey: 'my-key' });
  await c.delete(1);

  assert.deepEqual(seen.map((s) => s.method), ['POST', 'PATCH', 'DELETE']);
  assert.deepEqual(seen[0]!.body, { title: 'a' });
  assert.ok(seen[0]!.headers['Idempotency-Key']!.length > 10, 'a key is generated');
  assert.equal(seen[1]!.headers['Idempotency-Key'], 'my-key');
  assert.equal(seen[2]!.url.pathname, '/v1/connections/c/collections/x/records/1');
});

test('record ids are encoded so they cannot change the path', async () => {
  const { fn, seen } = fakeFetch([json({ data: {} })]);
  await new SethuClient({ ...base, fetch: fn }).collection('c', 'x').get('../../admin?x=1');
  assert.equal(seen[0]!.url.pathname, '/v1/connections/c/collections/x/records/..%2F..%2Fadmin%3Fx%3D1');
});

test('errors: API codes become typed errors with the request id', async () => {
  const body = { error: { code: 'CAPABILITY_UNSUPPORTED', message: 'No OR here', details: { field: 'a' }, requestId: 'req_9' } };
  const { fn } = fakeFetch([json(body, 422)]);
  await assert.rejects(new SethuClient({ ...base, fetch: fn }).collection('c', 'x').create({}), (e) => {
    assert.ok(isSethuApiError(e));
    assert.equal(e.code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(e.status, 422);
    assert.equal(e.requestId, 'req_9');
    assert.deepEqual(e.details, { field: 'a' });
    return true;
  });
});

test('errors: non-JSON failures use the status and never repeat the body', async () => {
  const { fn } = fakeFetch([new Response('<html>secret stack trace</html>', { status: 500 })]);
  await assert.rejects(new SethuClient({ ...base, fetch: fn, maxRetries: 0 }).collection('c', 'x').get(1), (e) => {
    assert.ok(e instanceof SethuApiError);
    assert.equal(e.code, 'INTERNAL');
    assert.ok(!e.message.includes('secret'));
    return true;
  });
  const { fn: fn404 } = fakeFetch([new Response('nope', { status: 404 })]);
  await assert.rejects(new SethuClient({ ...base, fetch: fn404 }).collection('c', 'x').get(1), (e) => isSethuApiError(e) && e.code === 'NOT_FOUND');
});

test('reads are retried on temporary failures, honouring Retry-After', async () => {
  const { fn, seen } = fakeFetch([
    json({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429, { 'Retry-After': '0.01' }),
    new Error('socket hang up'),
    json({ data: { id: 1 } }),
  ]);
  const record = await new SethuClient({ ...base, fetch: fn }).collection('c', 'x').get(1);
  assert.deepEqual(record, { id: 1 });
  assert.equal(seen.length, 3);
});

test('reads give up after maxRetries; writes are never retried', async () => {
  const failing = () => json({ error: { code: 'CONNECTION_FAILED', message: 'x' } }, 502);
  const read = fakeFetch([failing, failing, failing]);
  await assert.rejects(new SethuClient({ ...base, fetch: read.fn, maxRetries: 2 }).collection('c', 'x').get(1), (e) => isSethuApiError(e) && e.code === 'CONNECTION_FAILED');
  assert.equal(read.seen.length, 3);

  const write = fakeFetch([failing, failing]);
  await assert.rejects(new SethuClient({ ...base, fetch: write.fn }).collection('c', 'x').create({}));
  assert.equal(write.seen.length, 1, 'a failed write is not repeated automatically');
});

test('client errors are not retried', async () => {
  const { fn, seen } = fakeFetch([json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403), json({ data: {} })]);
  await assert.rejects(new SethuClient({ ...base, fetch: fn }).collection('c', 'x').get(1), (e) => isSethuApiError(e) && e.code === 'FORBIDDEN');
  assert.equal(seen.length, 1);
});

test('iterate: follows cursors until the last page', async () => {
  const page = (ids: number[], next: string | null) => json({ data: ids.map((id) => ({ id })), page: { nextCursor: next, limit: 2 } });
  const { fn, seen } = fakeFetch([page([1, 2], 'c1'), page([3, 4], 'c2'), page([5], null)]);
  const ids: unknown[] = [];
  for await (const record of new SethuClient({ ...base, fetch: fn }).collection('c', 'x').query().limit(2).iterate()) ids.push(record['id']);

  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((s) => s.url.searchParams.get('cursor')), [null, 'c1', 'c2']);
});

test('iterate: stops with an error instead of looping forever', async () => {
  const endless = () => json({ data: [], page: { nextCursor: 'again', limit: 1 } });
  const { fn } = fakeFetch(Array.from({ length: 5 }, () => endless));
  await assert.rejects(async () => {
    for await (const _ of new SethuClient({ ...base, fetch: fn }).collection('c', 'x').query().iterate({ maxPages: 3 })) { /* none */ }
  }, RangeError);
});

test('first: returns one record or null', async () => {
  const { fn } = fakeFetch([json({ data: [{ id: 7 }], page: { nextCursor: null, limit: 1 } }), json({ data: [], page: { nextCursor: null, limit: 1 } })]);
  const c = new SethuClient({ ...base, fetch: fn }).collection('c', 'x');
  assert.deepEqual(await c.query().first(), { id: 7 });
  assert.equal(await c.query().first(), null);
});

test('builders are immutable, so a base query can be reused', async () => {
  const { fn, seen } = fakeFetch([json({ data: [], page: { nextCursor: null, limit: 50 } }), json({ data: [], page: { nextCursor: null, limit: 50 } })]);
  const base1 = new SethuClient({ ...base, fetch: fn }).collection('c', 'x').where(eq('a', 1));
  await base1.where(eq('b', 2)).list();
  await base1.list();
  assert.deepEqual(JSON.parse(seen[1]!.url.searchParams.get('filter')!), eq('a', 1));
});

test('base URL safety', () => {
  assert.throws(() => new SethuClient({ baseUrl: 'http://cms.example.com' }), /https/);
  assert.throws(() => new SethuClient({ baseUrl: 'ftp://cms.example.com' }));
  assert.throws(() => new SethuClient({ baseUrl: 'https://user:pw@cms.example.com' }), /credentials/);
  assert.throws(() => new SethuClient({ baseUrl: 'not a url' }));
  assert.doesNotThrow(() => new SethuClient({ baseUrl: 'http://localhost:8080' }));
  assert.doesNotThrow(() => new SethuClient({ baseUrl: 'http://cms.internal', allowInsecureHttp: true }));
});

test('network failure and timeout become typed errors', async () => {
  const down = fakeFetch([new Error('ECONNREFUSED')]);
  await assert.rejects(new SethuClient({ ...base, fetch: down.fn, maxRetries: 0 }).collection('c', 'x').get(1), (e) => isSethuApiError(e) && e.code === 'CONNECTION_FAILED' && e.status === 0);

  const slow = (async (_url: URL, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
  await assert.rejects(new SethuClient({ ...base, fetch: slow, timeoutMs: 20, maxRetries: 0 }).collection('c', 'x').get(1), (e) => isSethuApiError(e) && e.code === 'TIMEOUT');
});

test('caller cancellation is passed through, not disguised as a network error', async () => {
  const controller = new AbortController();
  const hang = (async (_url: URL, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
  const pending = new SethuClient({ ...base, fetch: hang }).collection('c', 'x').get(1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => !isSethuApiError(e));
});

test('health check never throws', async () => {
  assert.equal(await new SethuClient({ ...base, fetch: fakeFetch([json({ status: 'ok' })]).fn }).isHealthy(), true);
  assert.equal(await new SethuClient({ ...base, fetch: fakeFetch([new Error('x')]).fn, maxRetries: 0 }).isHealthy(), false);
});
