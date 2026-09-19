# Runbook: Railway production

## Topology

One public origin, everything else on the private network.

| Service | Exposure | `CONVO_SERVICE_KIND` | `CONVO_PROCESS_ROLE` | Status |
| --- | --- | --- | --- | --- |
| `convo-client-demo` | **public** | `web` | — | deployed |
| `convo-api` | private | (default) | `api` | deployed |
| `convo-worker-inbound` | private | (default) | `worker-inbound` | deployed |
| `convo-worker-interactive` | private | (default) | `worker-interactive` | deployed |
| `convo-worker-campaign` | private | (default) | `worker-campaign` | deployed |
| `convo-worker-report` | private | (default) | `worker-report` | deployed |
| `convo-worker-integration` | private | (default) | `worker-integration` | **new — must be deployed** |
| `convo-worker-automation` | private | (default) | `worker-automation` | **new — must be deployed** |
| `Postgres` | private | — | — | deployed |
| `convo-database` | one-shot | `database` | — | deployed |

The browser talks only to the public web service, which reverse-proxies
`/api/*` to `http://convo-api.railway.internal:3000`, preserving cookies,
bodies, response headers and SSE. Neither the API nor PostgreSQL has a public
domain.

`worker-integration` and `worker-automation` are new in this release and
**must be created before it is deployed**. Without the first, no invitation or
password-recovery email is ever sent. Without the second, no automation schedule
is ever materialized. See ADR-0018 for why they are two services and not one.

The `ingress` and `realtime` roles exist in the artifact but are not deployed as
separate services; the `api` role serves those routes today. Splitting them is a
scaling decision, not a correctness one.

## Health checks

Point each service's Railway health check at:

| Service | Path |
| --- | --- |
| `convo-client-demo` | `/healthz` |
| `convo-api` | `/ready` |
| every worker | `/ready` |

`/live` exists on every service too and is what a **restart** policy should use.
Never point a restart policy at `/ready`: it depends on PostgreSQL, so a database
blip would restart every instance simultaneously — turning a recoverable
dependency failure into a full outage at the moment the dependency can least
absorb a reconnection storm.

Workers additionally serve `/metrics` with tick counts, error counts, the
fairness pair and `last_tick_at`.

## Required variables

Shared by `convo-api` and every worker:

```
CONVO_DEPLOYMENT_MODE=self_hosted_single
CONVO_INSTALLATION_NAME=...
CONVO_PUBLIC_BASE_URL=https://<the public origin>
CONVO_DEFAULT_LOCALE=ar
CONVO_SUPPORTED_LOCALES=ar,en
CONVO_AUTH_HASH_SECRET=...            # openssl rand -hex 32, all three distinct
CONVO_BOOTSTRAP_TOKEN=...
CONVO_IDEMPOTENCY_HASH_SECRET=...
CONVO_PG_*=...                        # Railway reference variables
CONVO_LOG_LEVEL=info
NODE_ENV=production
```

`convo-api` additionally:

```
CONVO_PROCESS_ROLE=api
CONVO_API_PORT=3000
CONVO_TRUSTED_PROXY_HOPS=2            # Railway edge, then our web proxy
```

**`CONVO_TRUSTED_PROXY_HOPS` is not optional on this topology.** At the default
of `0` the API sees the web service's address for every request, so every user
shares one login rate-limit bucket and five failed attempts from anyone lock out
the entire installation for fifteen minutes. Setting it too high is the opposite
failure: a client could then choose its own bucket with a header and never be
rate limited at all. On this topology the value is `2`.

Each worker sets its own `CONVO_PROCESS_ROLE` and may set
`CONVO_WORKER_CONCURRENCY` (default 4).

Only `convo-worker-integration` receives email-provider configuration when
delivery is deliberately enabled:

```
CONVO_EMAIL_PROVIDER=resend
CONVO_EMAIL_FROM=...                  # on a domain verified with Resend
CONVO_RESEND_API_KEY=...
```

Absent provider configuration leaves that worker in explicit disabled mode;
production rejects `logging`. Do not deploy it to drain real rows until the
provider is verified. Core API and unrelated workers do not need these values.

`convo-client-demo`:

```
CONVO_SERVICE_KIND=web
CONVO_API_ORIGIN=http://convo-api.railway.internal:3000
PORT=<Railway-provided>
```

Optional, per feature:

```
CONVO_CHANNEL_TRANSPORT=meta          # default `none` refuses every send, visibly
CONVO_CHANNEL_SECRET_<REF>=...        # Meta app secret, per app registration
CONVO_CREDENTIAL_KEYS=v1:<base64 32 bytes>
CONVO_BROKER_URL=...                  # arms the integration worker's fail-closed check
```

## Deploying a release

Every service builds from the root `Dockerfile`; `deploy/start.sh` selects web,
database or API/worker from `CONVO_SERVICE_KIND`, and the role comes from
`CONVO_PROCESS_ROLE` alone.

Schema first, then the things that read it:

```bash
railway up --service convo-database          --environment production --detach
# require exit 0 before continuing

railway up --service convo-worker-inbound     --environment production --detach
railway up --service convo-worker-interactive --environment production --detach
railway up --service convo-worker-campaign    --environment production --detach
railway up --service convo-worker-report      --environment production --detach
railway up --service convo-worker-integration --environment production --detach
railway up --service convo-worker-automation  --environment production --detach

railway up --service convo-api                --environment production --detach
railway up --service convo-client-demo        --environment production --detach
```

`convo-database` must exit successfully, reporting either the migrations it
applied or `no pending migrations`. **A checksum mismatch is a failed
deployment.** Fix it with a new forward-only migration, never by editing an
applied one.

Take a database snapshot before step 1. Migrations are forward-only and there is
no down path.

## After deploying

1. `GET /healthz` on the public origin.
2. `GET /ready` on `convo-api` and every worker — all `200`.
3. `GET /metrics` on each worker — `last_tick_at` is advancing.
4. Sign in as the production owner **through the public origin**, not through a
   port-forward: that is the only path that exercises the cookie, CSRF and proxy
   configuration together.
5. Open the Inbox, open a conversation, read a campaign report.
6. Confirm `email_deliveries` is draining:
   `SELECT state, count(*) FROM email_deliveries GROUP BY state;`
7. Confirm every service reports `SUCCESS`, and that `convo-database` shows a
   completed deployment with zero running replicas.

## Release traceability

A deployment must be identifiable from a commit and back. Record, per release:

| | |
| --- | --- |
| Git SHA | the exact commit built |
| Tag | e.g. `v1.0.0-rc.1` |
| Migration high-water mark | the last filename in `schema_migrations` |
| Railway deployment ids | one per service |

"Approximately the version in my local folder" is not a release. Tag the commit,
deploy that tag, and write the four values above into the release notes.
