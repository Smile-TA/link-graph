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
docker compose up -d --wait          # Postgres + Redis (+ the worker, if its image builds)
npx link-graph migrate               # apply packages/db/migrations; safe to re-run, no-ops when current
```

`docker compose up -d --wait` also builds and starts the `worker` service
(`Dockerfile.worker`). If that build fails (a flaky `npm ci` has been seen — an npm bug,
not a code issue — retry it), start the worker directly on the host instead, using the
same `node_modules` the CLI already resolves against:

```
docker compose up -d --wait postgres redis
npx tsx packages/scheduler/src/bin.ts &
```

Either way, the worker prints how many sites it scheduled on boot:

```
link-graph-worker: 164 site(s) scheduled weekly, 0 disabled site(s) skipped
```

To stop everything: `docker compose down` (add `-v` only if you actually want to drop
`pgdata` — see §7). Kill a host-run worker with its PID or `pkill -f
'scheduler/src/bin.ts'`.

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
Monday 03:00, `upsertJobScheduler` keyed on the site id, so restarting the worker
re-registers the same schedule rather than adding a second one.

- **Change the cadence:** edit `WEEKLY_CRON` in `packages/scheduler/src/schedule.ts`
  (a standard 5-field cron pattern) and restart the worker — there's no env override
  today.
- **See what's scheduled:**
  ```
  docker exec link-graph-redis-1 redis-cli keys 'bull:crawl:repeat:*'
  ```
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

Or query the database directly — this is the ground truth the CLI reads too:

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

```
docker compose ps                                    # postgres/redis/worker containers up + healthy
ps aux | grep 'scheduler/src/bin.ts'                 # if the worker's running on the host instead
docker exec link-graph-redis-1 redis-cli ping         # PONG = redis reachable
docker exec link-graph-postgres-1 pg_isready -U link_graph -d link_graph
```

Job counts and failures, from Redis (BullMQ's own bookkeeping):

```
docker exec link-graph-redis-1 redis-cli keys 'bull:crawl:[0-9]*'   # individual job ids (not repeat schedulers)
docker exec link-graph-redis-1 redis-cli hget 'bull:crawl:<id>' failedReason
```

A job with no `failedReason` and no matching `crawls` row yet is still running or
still queued; one with a `failedReason` is a site-level refusal (unresolvable truth
source, unreachable homepage, etc. — PRD §5/§15's "refuse rather than guess" rules) and
never wrote a `crawls` row at all.

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

```
cd packages/web
npm run dev      # http://localhost:4321, live against DATABASE_URL
npm run build && npm run start   # production build
```

Reads Postgres only — no separate service to keep alive besides the database itself.
