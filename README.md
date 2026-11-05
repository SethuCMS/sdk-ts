# @sethucms/sdk

TypeScript client for the SethuCMS API. Runs in Node 20+, browsers and edge runtimes. No dependencies.

```ts
import { SethuClient, eq, gt } from '@sethucms/sdk';

const cms = new SethuClient({ baseUrl: 'https://cms.example.com', token: () => getAccessToken() });
const orders = cms.collection('conn_123', 'orders');

// One page
const page = await orders.where(eq('status', 'paid')).where(gt('total', 100)).orderBy('created_at', 'desc').limit(20).list();

// Every matching record, page after page
for await (const order of orders.where(eq('status', 'paid')).iterate()) {
  console.log(order);
}

// Writes (a random idempotency key is added, so a retried write cannot happen twice)
const created = await orders.create({ status: 'new' });
await orders.update(created['id'] as number, { status: 'paid' });
await orders.delete(created['id'] as number);
```

## Counts

```ts
const { count, exact } = await orders.where(eq('status', 'paid')).count();   // exact: false means "at least"
const all = await cms.counts('conn_123');                                       // every collection you can read, one call
```

Counting is capped (default 1000, `{ max }` up to 10000), so a huge table answers quickly. It uses your permissions, so it never counts rows a list would hide.

## Drafts and scheduled publishing

```ts
const draft = await orders.drafts.create({ recordId: 7, values: { status: 'paid' } });
await orders.drafts.schedule(draft.id, new Date('2026-12-01T09:00:00+05:30'));   // publishes by itself then
await orders.drafts.cancelSchedule(draft.id);
await orders.drafts.publish(draft.id, { version: draft.version });              // or publish now
```

A scheduled draft publishes its latest saved values with your permissions. If that fails (for example the record
changed meanwhile) nothing is published and the draft's `scheduleError` says why. A gateway that runs serverless
refuses to schedule with `CAPABILITY_UNSUPPORTED`.

## Errors

Every failure is an `SethuApiError` with a stable `code`:

```ts
import { isSethuApiError } from '@sethucms/sdk';

try {
  await orders.create({ status: 'new' });
} catch (error) {
  if (isSethuApiError(error) && error.code === 'READ_ONLY') {
    // This connection does not allow writes.
  }
}
```

Codes: `VALIDATION_FAILED`, `AUTH_FAILED`, `FORBIDDEN`, `READ_ONLY`, `NOT_FOUND`, `CONFLICT`, `CAPABILITY_UNSUPPORTED`, `RATE_LIMITED`, `CONNECTION_FAILED`, `TIMEOUT`, `INTERNAL`. `error.requestId` is the id to quote to support.

## Safe by default

- `baseUrl` must be https (plain http only for localhost). Credentials in the URL are refused.
- The token travels in the `Authorization` header, never in the URL.
- Reads are retried (default twice) on 429, 502, 503, 504 and network errors, honouring `Retry-After`. Writes are never retried automatically.
- Requests time out after 30 seconds by default (`timeoutMs`).
- Ids are URL-encoded, so a hostile id cannot change the request path.
- Error messages never repeat a raw response body.
- Cookies are never sent (`credentials: 'omit'`).

## Notes

- The filter is sent as JSON in the query string. Very large filters can hit URL length limits.
- This SDK follows the REST contract in `sethucms-docs/docs/08-api.md`. The gateway that serves it lives in the `sethucms` repository (`apps/api`). The unit tests use a scripted `fetch`; the example apps in `sethucms-examples` run this SDK against a real gateway.
