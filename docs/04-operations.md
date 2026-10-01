# link-graph — Operations

How to run this thing: boot the stack, load the site registry, see what the scheduler
is doing, check on a run, check the worker is alive, and back up / recover the
database. Assumes the local docker-compose stack (Postgres + Redis); "deploying it
somewhere" is future work and out of scope here.

Every command below assumes you're in the repo root with dependencies installed
(`npm install`), and reaches Postgres via `DATABASE_URL` (defaults to the local
docker-compose DSN — see `packages/db/src/config.ts`) and Redis via `REDIS_URL`
(defaults to `redis://localhost:6379`).

---

## 1. Start the stack

```
docker compose up -d --wait          # Postgres + Redis + the worker + the web dashboard
npx link-graph migrate               # apply packages/db/migrations; safe to re-run, no-ops when current
```

`docker compose up -d --wait` also builds and starts the `worker` service
(`Dockerfile.worker`). Its build used to fail on `npm ci` with a useless-looking
"Exit handler never called!" npm-itself bug report — that was never an npm bug: this
network's Zscaler proxy re-signs outbound TLS with its own root CA, which
`node:22-slim` had no reason to trust, so every HTTPS fetch (`npm ci` against the
registry, `curl` against github.com in `scripts/fetch-lychee.sh`) failed cert
validation and npm 10.9.9 mangled that into the misleading message. Fixed
(2026-09-28) by baking `certs/zscaler-root-ca.pem` into both the build and runtime
stage of `Dockerfile.worker` (`update-ca-certificates` for `curl`'s OS trust store,
`NODE_EXTRA_CA_CERTS` for Node's own). Two more bugs were only visible once the build
actually got past that: `scripts/` was never `COPY`'d into the image (so
`fetch-lychee.sh` couldn't be found), and the vendored `lychee` release targeted `gnu`
(glibc 2.38+) against a base image with glibc 2.36 — switched to the `musl` static
build in `scripts/fetch-lychee.sh`, which has no libc version dependency at all.

If the build still fails on a network this fix wasn't written for (no Zscaler, or a
different intercepting proxy), the fallback is to start the worker directly on the
host instead, using the same `node_modules` the CLI already resolves against:

```
docker compose up -d --wait postgres redis
npx tsx packages/scheduler/src/bin.ts &
```

Either way, the worker prints how many sites it scheduled on boot:

```
link-graph-worker: 164 site(s) scheduled weekly, 0 disabled site(s) skipped
```

**Why `npx tsx packages/scheduler/src/bin.ts` has to keep running** (docs/notes.md
item 9a): that one line boots two long-lived BullMQ `Worker`s (crawl, linkcheck —
`createWorkers`, `packages/scheduler/src/worker.ts`), which is what actually *pulls*
jobs off the Redis queues and runs them. `scheduleWeeklyCrawls` only writes the
Sunday-03:00 job schedulers into Redis on boot — it's registration, not execution — so
without the process staying up there's nothing consuming those queues: jobs would sit
`waiting` in Redis forever, `crawls` rows would never get written, and `docker compose
ps` would show the worker container gone rather than idle. It does **not** re-run
`scheduleWeeklyCrawls` on any timer of its own; that only fires once, at boot
(`bin.ts`'s own startup path). A *restart* of the process re-registers the same
schedule (`upsertJobScheduler` keys on site id, so it's idempotent, not a second
schedule stacked on the first) — but nothing re-schedules while it's already running.

To stop everything: `docker compose down` (add `-v` only if you actually want to drop
`pgdata` — see §7). Kill a host-run worker with its PID or `pkill -f
'scheduler/src/bin.ts'`.

`docker compose down` only stops the containers — any worker started on the host
(§1's fallback) keeps running and will spam `ECONNREFUSED 127.0.0.1:6379` once Redis
is gone. Host-run workers also don't get replaced on re-run if you forget to kill the
old one first, so they can pile up as duplicate processes over days. Check for
leftovers and clear them all with:

```
ps aux | grep 'scheduler/src/bin.ts'
pkill -9 -f 'scheduler/src/bin.ts'   # -9: plain pkill has been seen not to land
```

## 2. Load the sites (registry sync)

The worker only schedules sites already in the `sites` table. Populate/refresh it from
`deployment-configurations`:

```
npx link-graph registry sync      # clone, derive, merge curation, upsert sites, probe liveness
npx link-graph registry report    # coverage-drift: deployed-but-unmonitored / configured-but-dead
```

`registry sync` is safe to re-run — it's an upsert, and a partial clone read never
blanks the rest of the estate (engineering guide §1). A disabled site (curation
overlay, or a failed liveness probe) is kept in `sites` but skipped by the scheduler —
see §3's caveat about a site disabled *after* it was already scheduled.

## 3. Scheduling ("cron")

There's no OS/Jenkins cron — the worker registers its own BullMQ job scheduler for
every enabled site on every boot (`scheduleWeeklyCrawls`, `packages/scheduler/src/schedule.ts`):
Sunday 03:00, `upsertJobScheduler` keyed on the site id, so restarting the worker
re-registers the same schedule rather than adding a second one.

- **Change the cadence:** edit `WEEKLY_CRON` in `packages/scheduler/src/schedule.ts`
  (a standard 5-field cron pattern) and restart the worker — there's no env override
  today.
- **See what's scheduled:**
  ```
  docker exec link-graph-redis-1 redis-cli keys 'bull:crawl:repeat:*'
  ```
  Or Bull Board (docs/notes.md item 4, §5 below) — a browser view of the same queues,
  easier for "what's queued / active / failed right now" than raw `redis-cli`.
- **Force a crawl now, without waiting for the schedule:** either run it synchronously
  (`npx link-graph crawl <site-id>`, blocks until done, prints the report), or enqueue
  it onto a running worker:
  ```ts
  // one-off script, run with: npx tsx <script>.ts   (must resolve inside the workspace)
  import { createQueues, redisConnection } from "@link-graph/scheduler";
  const queues = createQueues(redisConnection(process.env.REDIS_URL ?? "redis://localhost:6379"));
  await queues.crawl.add("<site-id>", { siteId: "<site-id>" });
  await Promise.all([queues.crawl.close(), queues.linkcheck.close()]);
  ```
- **Known gap:** a site disabled after it was already scheduled keeps its old
  scheduler — `scheduleWeeklyCrawls` skips disabled sites going forward but never
  removes an existing one. Remove it by hand if that matters:
  ```
  docker exec link-graph-redis-1 redis-cli del 'bull:crawl:repeat:<site-id>'
  ```

## 4. Check a run

```
npx link-graph report <site-id>     # last complete crawl's findings, split by review state
```

Or query the database directly — this is the ground truth the CLI reads too. **A GUI
for this** (docs/notes.md item 9c): there's no Postgres equivalent of Bull Board in
this stack, and none is being added — the
[Database Client](https://database-client.com/) VS Code extension already does the
job (browse tables, run ad hoc SQL, no separate service to keep running). Point it at
the same DSN everything else uses: `postgres://link_graph:link_graph@localhost:5432/link_graph`.

```sql
-- recent crawls and their outcome
select s.site_id, c.status, c.started_at, c.finished_at
from crawls c join sites s on s.id = c.site_id
order by c.id desc limit 20;

-- what changed since the previous complete crawl for one site
select * from crawl_diffs where crawl_id = (
  select id from crawls where site_id = (select id from sites where site_id = '<site-id>')
  order by id desc limit 1
);
```

`status` is one of `running`, `complete`, `partial` (resumable — see the crawl's own
message for `resumeCrawl(pool, <id>)`), or `failed`. A `failed` job's reason is on the
BullMQ job itself, not in Postgres — see §5.

## 5. Check worker health

**"Is the worker process itself alive?"** (docs/notes.md item 20 — this, not "which
site is crawling right now": that's Bull Board's Active tab, below) is exactly what
these already answer, nothing further to build:

```
docker compose ps                                    # postgres/redis/worker containers up + healthy
ps aux | grep 'scheduler/src/bin.ts'                 # if the worker's running on the host instead
docker exec link-graph-redis-1 redis-cli ping         # PONG = redis reachable
docker exec link-graph-postgres-1 pg_isready -U link_graph -d link_graph
```

Job counts and failures, from Redis (BullMQ's own bookkeeping) — or from Bull Board,
below, which is the same data without hand-typed `redis-cli` keys:

```
docker exec link-graph-redis-1 redis-cli keys 'bull:crawl:[0-9]*'   # individual job ids (not repeat schedulers)
docker exec link-graph-redis-1 redis-cli hget 'bull:crawl:<id>' failedReason
```

A job with no `failedReason` and no matching `crawls` row yet is still running or
still queued; one with a `failedReason` is a site-level refusal (unresolvable truth
source, unreachable homepage, etc. — PRD §5/§15's "refuse rather than guess" rules) and
never wrote a `crawls` row at all.

**Bull Board** (docs/notes.md item 4): a browser dashboard over the same queues,
started with the rest of the stack. http://localhost:3000 — Active/Waiting/Failed
per queue, a job's `failedReason`, retry/remove buttons. Bound to `127.0.0.1` only
(not `0.0.0.0`, unlike the other services) because it has no auth configured and its
own actions are destructive — the CLI itself warns on startup that anyone who can
reach it can modify or delete any queue's jobs, not just view them. A restart of
this container reinstalls `@bull-board/cli` from scratch via `npx` (~15s) since it
runs off the plain `node:22-slim` image rather than a built one — see the
`bull-board` service's own comment in `docker-compose.yml` for why that trade is
made deliberately here and not for `worker`/`web`.

If Bull Board feels slow to respond: **confirmed cause, 2026-09-28** — it was measured
slow while 12 stale duplicate `scheduler/src/bin.ts` host processes were running
unnoticed (each one registering its own weekly job scheduler on top of the others —
see §1's note on host-run workers piling up). After killing them, Redis measured
trivially small (`used_memory` ~2MB, `dbsize` 322 keys — nowhere near a scale that
would explain slowness on its own) and Bull Board responded in single-digit
milliseconds. So: if it's slow again, check the worker process count first
(`ps aux | grep 'scheduler/src/bin.ts'`, above) — that was the actual cause, not
Redis. Only if the process count is already clean and it's still slow is a genuine
Redis-scale problem worth checking:

```
docker exec link-graph-redis-1 redis-cli info memory
docker exec link-graph-redis-1 redis-cli dbsize
```

## 6. Back up the database

Postgres is the system of record (PRD §8) — its history can't be re-derived. Plain-SQL
dump, portable and diffable:

```
docker exec link-graph-postgres-1 pg_dump -U link_graph -d link_graph \
  > backup-$(date +%Y%m%d-%H%M%S).sql
```

Or the compressed custom format, needed for parallel restore of a large estate:

```
docker exec link-graph-postgres-1 pg_dump -U link_graph -d link_graph -Fc \
  > backup-$(date +%Y%m%d-%H%M%S).dump
```

Automate by cron'ing whichever form on the host running the compose stack — nothing
in this repo schedules its own backups yet.

## 7. Recover the database

Into a **fresh** container/volume (`docker compose down -v` first, then `up -d --wait
postgres`, then `npx link-graph migrate` if restoring the plain-SQL form onto an empty
schema — skip `migrate` if the dump already includes `schema_migrations` and every
table):

```
# plain SQL dump
cat backup-20260925-153000.sql | docker exec -i link-graph-postgres-1 \
  psql -U link_graph -d link_graph

# custom-format dump (parallel restore, -j4 workers)
docker exec -i link-graph-postgres-1 pg_restore -U link_graph -d link_graph -j4 \
  < backup-20260925-153000.dump
```

`docker compose down -v` deletes the `pgdata` volume — confirm you actually want that,
and that a backup exists, before running it (see the safety note already on the
volume's own comment in `docker-compose.yml`).

## 8. The web dashboard

`docker compose up -d --wait` now also builds and starts a `web` service
(`Dockerfile.web`, docs/notes.md item 14) at http://localhost:4321, live against the
compose Postgres. That's the one to use day to day — no separate terminal, comes and
goes with the rest of the stack. It's a production build (`astro build` once, then the
compiled `entry.mjs`), not `astro dev` — the same build-then-run split
`Dockerfile.worker` already uses, since a container that rebuilds on every file-watch
tick isn't what "part of the compose stack" means.

For iterating on the web package itself, with live-reload, still run it on the host:

```
cd packages/web
npm run dev      # http://localhost:4321, live against DATABASE_URL
npm run build && npm run start   # production build, same as the compose service does
```

A host-run dev server and the compose `web` service both default to port 4321 — stop
one before starting the other, or override with `PORT`.

Reads Postgres and Redis (`listNextCrawlTimes`, for the sites list's next-crawl
column) — no separate service to keep alive besides those two. It also **writes**
Postgres now: `docs/notes.md` item 7's review form (`/sites/:slug/review`) upserts or
deletes a `finding_reviews` row per submission, the one mutating route in an otherwise
read-only dashboard.

**Before this goes anywhere beyond `docker compose` on localhost, it needs auth.**
Every route in `packages/web` — including the write one — is unauthenticated today,
which was an acceptable gap while every route only read data (worst case, someone sees
orphan counts). A `POST` that can delete or overwrite a human's review is a different
risk once this sits behind a real ingress rather than `localhost:4321` reachable only
from this machine. This is the same reasoning that got `bull-board` bound to
`127.0.0.1` instead of `0.0.0.0` (§3) rather than published — the dashboard doesn't
have that luxury once it is the thing people are meant to reach, so it needs its own
answer (HTTP basic auth in front, or whatever this estate's other internal tools use)
before "deploying it somewhere" (line 5) stops being out of scope. No proposal yet —
recorded here so it isn't forgotten when that phase starts.
