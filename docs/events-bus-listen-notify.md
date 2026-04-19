# Event bus — Postgres LISTEN/NOTIFY migration plan

**Status**: DECISION RECORD ONLY. Do not implement until the trigger criteria below are met.

**Issue**: [#151](https://github.com/ingamartinez/personal-financial-dashboard/issues/151)

---

## TL;DR

Today `src/lib/events/bus.ts` is an in-process `EventEmitter` stored on `globalThis`. It works perfectly for the current single-process deploy on the DigitalOcean Droplet. If we ever run more than one Next.js process (pm2 cluster mode, multiple containers, multi-region, blue/green), cross-process delivery breaks silently — server actions on instance A never reach SSE clients connected to instance B.

The mitigation is to back the bus with Postgres `LISTEN/NOTIFY` so every process sees every event. The current API (`emit`, `subscribe`, `AppEvent`) is stable enough that the swap is a **single-file change** to `src/lib/events/bus.ts`. No callsite needs to move.

---

## When to actually do this (trigger criteria)

Migrate the moment ANY of these becomes true:

1. We run more than one Next.js process for the same DB (pm2 `instances: 2+`, multi-container, blue/green deploys that overlap).
2. We split the worker (instrumentation hook) into a separate process from the web tier.
3. SSE live-refresh starts misbehaving in ways consistent with cross-process drift after we've added a second process for any reason (smoke or canary instances count).

Until then, leave the in-memory bus alone. The current setup is the right call for one process.

---

## Current API surface (audit)

`src/lib/events/bus.ts` exports exactly three things:

```ts
export type AppEvent = ...           // discriminated union, JSON-safe
export function emit(event: AppEvent): void
export function subscribe(listener: (event: AppEvent) => void): () => void
```

`AppEvent` is a discriminated union of six variants (`transaction:created`, `transaction:updated`, `transaction:bulk-updated`, `counterparty:updated`, `recurring-gap:resolved`, `budget:updated`). Every payload is already small primitives (`id: number`, `timestamp: number`, enum `reason`) — no full DB rows, no `Date` objects, no `BigInt`. JSON round-trip is lossless today.

### Caller audit (8 files total)

| File | Role |
| --- | --- |
| `src/app/(app)/transactions/actions.ts` | producer (`emit`) |
| `src/app/(app)/settings/recurring/actions.ts` | producer (`emit`) |
| `src/app/api/events/trigger/route.ts` | producer (`emit`) |
| `src/app/api/ingest/sms/route.ts` | producer (`emit`) |
| `src/lib/telegram/confirm.ts` | producer (`emit`) |
| `src/lib/recurring/auto-link.ts` | producer (`emit`) |
| `src/app/api/events/stream/route.ts` | consumer (`subscribe`) — the only SSE relay |
| `src/lib/hooks/use-live-events.ts` | type-only import (`AppEvent`) |
| `src/lib/events/bus.test.ts` | unit tests |

**Conclusion**: the API is stable. The swap is a single-file change to `src/lib/events/bus.ts`. No producer or consumer needs to move.

---

## Migration plan

### Step 1 — channel + payload

- Single Postgres channel: `findash_events`.
- Payload: `JSON.stringify(event)` of an `AppEvent`.
- Postgres `NOTIFY` caps payloads at ~8 KB. Largest current `AppEvent` JSON is ~150 bytes — 50x headroom. If we ever add a variant with a heavier payload (e.g. embedded counterparty diff), keep it under 4 KB and prefer `id`-only references that consumers re-fetch.

### Step 2 — `emit` becomes a NOTIFY

```ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function emit(event: AppEvent): Promise<void> {
  const payload = JSON.stringify(event);
  await db.execute(sql`SELECT pg_notify('findash_events', ${payload})`);
}
```

Note: `emit` becomes async. Today it's `void`. Audit after the migration whether any callsite relied on synchronous fire-and-forget — the only risk is unhandled-promise warnings, not lost events.

### Step 3 — `subscribe` becomes a multiplexed local fan-out

One long-lived `LISTEN findash_events` connection per Next.js process, fanning out to local subscribers in memory:

```ts
declare global {
  var __findashListenClient: import("postgres").Sql | undefined;
  var __findashLocalBus: EventEmitter | undefined;
}

async function getListener(): Promise<EventEmitter> {
  if (globalThis.__findashLocalBus) return globalThis.__findashLocalBus;

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  // Dedicated connection — NOT from the pool. LISTEN holds the conn open.
  const client = postgres({ /* ...connection opts... */ max: 1 });
  await client`LISTEN findash_events`;

  client.subscribe?.("findash_events", (payload) => {
    try {
      bus.emit("event", JSON.parse(payload) as AppEvent);
    } catch {
      // malformed payload — log + drop, do not crash the listener
    }
  });

  globalThis.__findashListenClient = client;
  globalThis.__findashLocalBus = bus;
  return bus;
}

export function subscribe(listener: (event: AppEvent) => void): () => void {
  // Fire-and-forget the connection bring-up; cache via globalThis ensures one per process.
  void getListener().then((bus) => bus.on("event", listener));
  return () => {
    globalThis.__findashLocalBus?.off("event", listener);
  };
}
```

Three things to verify against the actual `postgres.js` API at implementation time (this snippet is illustrative — check the docs):

1. `postgres.js` exposes `LISTEN/NOTIFY` via `sql.listen('channel', handler)`. Do not roll our own framing.
2. The listen connection MUST be separate from the query pool. Pool clients can be reset; listen holds a long-lived socket.
3. Reconnect: if the socket drops, `postgres.js` retries by default — confirm and set a backoff.

### Step 4 — HMR + Turbopack

The current bus uses `globalThis.__findashEventBus` to survive Turbopack HMR re-evaluation. Apply the same pattern to `__findashListenClient` AND `__findashLocalBus`. Without this, every HMR creates a new `LISTEN` connection and leaks DB sockets.

### Step 5 — graceful shutdown

In `instrumentation.ts` (or wherever the worker lives), on `SIGTERM`:

```ts
await globalThis.__findashListenClient?.end();
```

Without this, dangling `LISTEN` connections accumulate on the DB across deploys.

---

## Alternatives considered

| Option | Why not |
| --- | --- |
| **Redis pub/sub** | Extra dependency, extra ops surface, extra cost on the Droplet. We already have Postgres and it solves this natively. |
| **WebSocket service (e.g. Soketi, Pusher)** | Overkill for ~5 users. Adds an entire managed dependency. |
| **Polling from the browser** | Defeats the point of SSE. Worse UX, more DB load. |
| **Per-request `pg_notify` from API routes only** | Doesn't solve the cross-process delivery problem — only solves emission. The listener still has to multiplex. |

`LISTEN/NOTIFY` wins on three axes: zero new infra, native to the DB we already operate, and the current `AppEvent` shape fits inside the 8 KB cap with massive headroom.

---

## Risks & gotchas (document now, fix at implementation time)

1. **Listener connection drops silently.** `LISTEN` connections can die on network blips. Mitigation: subscribe to the `postgres.js` connection error event, log it, recreate the listener with exponential backoff. Add a heartbeat metric.
2. **`pg_notify` payload >8 KB throws.** Add a `JSON.stringify(event).length` assertion in dev / test. Cap at 4 KB defensively.
3. **`emit` becomes async.** All current callsites already live in `async` functions (server actions, route handlers). Spot-check after the swap that nothing accidentally fires from sync code.
4. **Test environment.** `bus.test.ts` runs with no DB. Either keep the in-memory implementation behind an env flag (`FINDASH_BUS=memory`) for tests, or use the real `findash_test` DB and assert `pg_notify` round-trips.
5. **HMR leaks listen connections** if the `globalThis` cache is missed on either the listener or the local bus. Both must be cached.
6. **Multiple writers on the same DB.** If a worker process and a web process both run `LISTEN`, both receive every event. That's the desired behavior — don't try to dedupe at the bus layer.

---

## Out of scope for this decision record

- Implementation. Open a new issue when the trigger criteria above are met.
- Replay/durability. `LISTEN/NOTIFY` is fire-and-forget. If we ever need replay (e.g. an SSE client that reconnects must catch up), that's a separate design — likely a `events` audit table, not a bus change.
- Cross-region delivery. Not relevant at current scale.
