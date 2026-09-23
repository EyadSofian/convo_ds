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
its live gate. Production email must be `resend` with a verified sender, or be
explicitly disabled for a core-only recovery; `logging` is non-production only.

## Database initialization

With the PostgreSQL variables loaded into the environment:

```bash
pnpm db:bootstrap
pnpm db:migrate
```

`bootstrap` establishes the least-privileged migration/runtime roles. `migrate`
applies forward-only migrations under an advisory lock. At this release the
expected final file is `0038_conversation_episode_actor_fk_set_null.sql`.

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
