# CONVO source handover and portable deployment

This guide deliberately uses no GitHub- or Railway-specific dependency. The
recipient needs the source archive, Node.js 22, pnpm 9.12.0 and PostgreSQL 17
(or a compatible managed PostgreSQL target). Docker is optional.

## Delivery contents

- Complete monorepo source, lockfile and checksummed migrations.
- One multi-role `Dockerfile` and `deploy/start.sh`.
- `.env.example` containing names and safe defaults only.
- API contract at `docs/api/openapi.v1.json`.
- Architecture, testing, recovery, alerting, email and Meta runbooks.
- Final audit and integration matrix under `docs/final/`.

The archive must exclude `.env*` values, provider tokens, database dumps,
coverage/browser output, `node_modules`, build output and private recovery
artifacts. Deliver the final Git SHA and a SHA-256 checksum alongside it.

## Verify the archive

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:property
pnpm test:contracts
pnpm test:security
pnpm test:coverage
```

Browser gates additionally require Chromium:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

## Configure

Copy `.env.example` to a private runtime configuration and replace every blank
secret. Generate the three hash/bootstrap secrets independently. Generate the
credential encryption key independently and retain its version prefix. Never
place any resulting file back in the source archive.

Use a server secret manager or injected process environment in production.
Provider credentials are not browser configuration. Set
`CONVO_CHANNEL_TRANSPORT=none` until an authorized Meta connection has passed
its live gate. Production email must be `smtp` or `resend` with a verified
sender, or be explicitly disabled for a core-only recovery; `logging` is
non-production only.

## Recipient deployment checklist

Connecting a hosting account to this GitHub repository is not, by itself, a
working installation. Before enabling automatic deployment, the recipient
should return the following **non-secret** information:

1. Hosting platform and topology: where PostgreSQL 17, the one-shot database
   bootstrap/migration job, the private API, the public web proxy, and each
   long-running worker will run. A frontend-only deployment cannot run the
   complete product. Only the web service should be public.
2. Git source: whether the deployment tracks this exact repository and `main`,
   or a fork/copy that needs its own synchronization. Record the full Git SHA
   actually deployed. A push to this repository does not update a fork or an
   archive automatically. Deploy only a SHA whose `verify` CI check passed.
3. Public HTTPS origin, private API origin, and the number of trusted proxy
   hops. `CONVO_PUBLIC_BASE_URL` and `CONVO_API_ORIGIN` must be set for the new
   topology; do not copy Railway's private hostname or its proxy-hop count.
4. Whether this is a **fresh installation** with an empty database, or a
   **migration** of existing users, conversations and channel connections.
   The latter requires a tested database backup/restore and the existing
   `CONVO_CREDENTIAL_KEYS` versions so encrypted channel credentials remain
   readable. Do not generate replacement keys and assume old ciphertext will
   decrypt. Coordinate an explicit cutover; do not run two independent sets
   of sending workers against the same live workload.
5. The secret manager and named operator who will enter values there. Send
   variable **names**, never values, through tickets or chat. Do not commit
   `.env`, provider tokens, database dumps or recovery artifacts to Git.

Use [`.env.example`](../../.env.example) for the complete variable names and
the [README configuration table](../../README.md#configuration) for meanings.
The minimum distribution is:

| Runtime role | Configuration to provide through the platform |
| --- | --- |
| API and workers | `NODE_ENV`, installation/public URL/locale variables, three independent auth/bootstrap/idempotency secrets, PostgreSQL runtime host/port/database/role/password, and `CONVO_PROCESS_ROLE` per process. |
| One-shot database job | PostgreSQL administrator, migration and runtime role credentials; `CONVO_SERVICE_KIND=database`. Run before API/web/workers on each release. |
| Public web | `CONVO_SERVICE_KIND=web`, private `CONVO_API_ORIGIN`, and the platform's `PORT`. It must serve `/api/*` on the **same public origin** as the browser. |
| API | `CONVO_PROCESS_ROLE=api`, API host/port and a topology-verified `CONVO_TRUSTED_PROXY_HOPS`. |
| Background workers | Separate processes for `worker-inbound`, `worker-interactive`, `worker-campaign`, `worker-report`, `worker-automation` and, when email/push is configured, `worker-integration`. |
| Meta channels, when enabled | `CONVO_CREDENTIAL_KEYS` on the processes that seal/open channel credentials; `CONVO_CHANNEL_TRANSPORT=meta` on API and sending workers. Legacy installation-managed apps also need their `CONVO_CHANNEL_SECRET_<REF>` value; workspace-managed app secrets and per-connection tokens remain encrypted in the database. |
| Email, when enabled | `CONVO_EMAIL_PROVIDER`, `CONVO_EMAIL_FROM`, and either Resend or SMTP credentials on `worker-integration` only. Verify the sending domain. |

No provider secret belongs in client-side build variables. The recipient should
run the same image/SHA for each role, apply migrations once, then report the
web `/healthz`, API/worker `/ready`, sign-in, and one controlled inbound and
outbound message result. For an existing Meta connection, update and verify
the webhook callback at the new public origin during cutover, not merely the
DNS record. Keep the old deployment available for rollback until these checks
pass. Repository GitHub Actions named `deploy-staging` and
`deploy-production` are Railway-specific; a new host needs its own deployment
integration and secrets. They are not activated by copying the source.

## Database initialization

With the PostgreSQL variables loaded into the environment:

```bash
pnpm db:bootstrap
pnpm db:migrate
```

`bootstrap` establishes the least-privileged migration/runtime roles. `migrate`
applies forward-only migrations under an advisory lock. At this release the
expected final file is `0044_managed_meta_apps.sql`.

## Run without Docker

Build once, then start each process with the same artifact and a distinct
`CONVO_PROCESS_ROLE`:

```bash
pnpm build
CONVO_PROCESS_ROLE=api node apps/api/dist/main.js
CONVO_SERVICE_KIND=web node apps/web/server.mjs
```

Long-running worker roles are `worker-inbound`, `worker-interactive`,
`worker-campaign`, `worker-report`, `worker-integration`, and
`worker-automation`. Run only the roles whose configuration has been validated.
Workers do not need public ports. The web service proxies same-origin `/api`
traffic to `CONVO_API_ORIGIN`.

## Run the common container image

`deploy/docker-compose.example.yml` runs every role on one host; the README
walks through it. For another platform:

```bash
docker build --pull -t convo:<git-sha> .
docker run --env-file /private/path/convo-api.env convo:<git-sha>
```

Use the same image digest for web, database/migration, API and worker services;
select behavior using `CONVO_SERVICE_KIND` and `CONVO_PROCESS_ROLE`. Do not bake
environment files into the image. The database role is a one-shot bootstrap and
migration process, not a public service.

## Health and rollout order

- Web: `GET /healthz`.
- API and HTTP roles: `GET /live` for process life and `GET /ready` for
  dependency readiness.
- Workers: use their readiness contract and structured startup/heartbeat logs;
  never expose a public provider endpoint just for a platform probe.

For a fresh installation: PostgreSQL, database bootstrap/migration, API, web,
then required workers. For an upgrade: create and verify a recovery point,
migrate once, deploy the same immutable image/SHA to every role, verify health,
then execute the authenticated and provider smoke gates.

## Recovery and ownership

Follow `docs/runbooks/DATABASE_RECOVERY.md`; restore a copy into isolation and
read it back before declaring recovery proven. Record ownership of DNS, TLS,
database, secret store, backups, alert destination and provider accounts in the
handover receipt. The application must remain operable from the delivered
source even if the original GitHub and Railway accounts are unavailable.
