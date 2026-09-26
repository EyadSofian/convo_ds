# DS Omnichannel

DS Omnichannel is a customer-conversation platform for support, sales and admissions teams. It brings WhatsApp, Facebook Messenger, Instagram, website chat and your own systems into one shared inbox. Around the inbox it adds contacts, WhatsApp broadcasts, automations and analytics.

The interface is available in Arabic and English, with full right-to-left support and light and dark themes. The server enforces every permission, so the browser never receives data that the signed-in person may not see.

This document is for the team that installs and runs DS Omnichannel on its own infrastructure.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [The database: what is automatic](#the-database-what-is-automatic)
- [Configuration](#configuration)
- [Deploy with Docker Compose](#deploy-with-docker-compose)
- [Deploy without Docker](#deploy-without-docker)
- [First run: create the company and its owner](#first-run-create-the-company-and-its-owner)
- [Connecting channels](#connecting-channels)
- [Email and notifications](#email-and-notifications)
- [Health checks and logs](#health-checks-and-logs)
- [Upgrading](#upgrading)
- [Backups and recovery](#backups-and-recovery)
- [Local development](#local-development)
- [Quality gates](#quality-gates)
- [Documentation](#documentation)
- [Security notes](#security-notes)

---

## Features

**Inbox**
- One queue for every channel, with unassigned and "mine" views, saved views and server-side filtering and search.
- Claim, assign, hand off and collaborate on conversations.
- Priorities, snooze with time zones, and resolve and reopen with reporting episodes.
- Private notes, labels and custom fields.
- An archive whose conversations can be brought back to the inbox in bulk, or deleted by administrators.
- Live updates over server-sent events, and optional browser push notifications.

**Contacts**
- Contact profiles with identities per channel and custom fields.
- CSV import and export.
- Consent history, where an opt-out always wins.
- A contact can be added with no channel yet. A channel is attached automatically when the customer writes in, or by hand from the profile.

**Channels**
- WhatsApp Business (Cloud API), Messenger and Instagram through a Meta app.
- A website chat channel for a widget on your own site.
- A signed **Custom API channel** that connects your own CRM, backend or bot.

**Broadcasts**
- WhatsApp broadcasts built on approved Meta templates, with variables bound to contact fields.
- Reusable audiences, approval and scheduling.
- Delivery evidence for every recipient.
- Everyone in the audience is reached except people who opted out.

**Automations**
- Event- and schedule-driven workflows: send a template, add a label, set a field, wait.
- A visual builder and a run log.

**Analytics**
- Campaign, operations, agent, team, response-time, resolution, assignment and channel reports.
- Rings, donuts, bar and column charts, alongside the full tables.
- Export any report as CSV, or every report as one Excel workbook.
- Print any report or save it as a PDF.

**Administration**
- Users, invitations, roles with fine-grained permissions, and teams.
- Sessions, audit trails and an ownership transfer flow.

---

## Architecture

```mermaid
flowchart LR
  browser([Browser]) -->|HTTPS| proxy[Your TLS proxy]
  proxy --> web[web<br/>app + /api proxy]
  web -->|/api/v1| api[api]
  meta([Meta / your systems]) -->|signed webhooks| proxy
  api --> pg[(PostgreSQL)]
  workers[workers<br/>inbound · interactive · campaign<br/>report · automation · integration] --> pg
  workers -->|send| providers([Meta · email · push])
  dbjob[database<br/>one-shot migrate] --> pg
```

The repository is a pnpm monorepo:

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS on Fastify. The REST API under `/api/v1` and every background worker. |
| `apps/web` | The web application (TypeScript, no framework). `apps/web/server.mjs` serves it and proxies `/api` to the API. |
| `packages/database` | SQL migrations and the `bootstrap` / `migrate` command. |
| `packages/domain` | Business rules shared by the API and the web app. |
| `deploy/` | The container entry point and a Docker Compose example. |
| `docs/` | Architecture, API contract, runbooks and decisions. |

One container image runs every part of the system. Two variables choose what a container does:

| Service | `CONVO_SERVICE_KIND` | `CONVO_PROCESS_ROLE` | Exposure | Purpose |
| --- | --- | --- | --- | --- |
| web | `web` | — | **public** | Serves the app and proxies `/api` to the API. The only service your users reach. |
| database | `database` | — | none, runs once | Creates the database and roles if missing, then applies new migrations and exits. |
| api | `api` (default) | `api` | private | The HTTP API, webhooks and the live event stream. |
| worker-inbound | `api` | `worker-inbound` | private | Turns inbound provider events into conversations and messages. |
| worker-interactive | `api` | `worker-interactive` | private | Delivers agents' replies and other interactive sends. |
| worker-campaign | `api` | `worker-campaign` | private | Plans and sends broadcasts. |
| worker-report | `api` | `worker-report` | private | Produces report exports. |
| worker-automation | `api` | `worker-automation` | private | Runs scheduled and event-driven automations. |
| worker-integration | `api` | `worker-integration` | private | Sends email and push notifications, and relays events to a broker if one is configured. |

Workers open no public port. Each serves `/live` and `/ready` on its own port for health checks.

---

## Requirements

- **PostgreSQL 17**, either self-managed or a managed service. You supply an empty server and one administrator login. The installer creates everything else.
- **Docker 24+ with Compose v2** (recommended), **or Node.js 22** with **pnpm 9.12** (`corepack enable`).
- **A domain and TLS certificate**, and a reverse proxy in front of the `web` service (Caddy, Nginx, Traefik or a cloud load balancer). Sign-in cookies are marked secure, so users must reach the app over HTTPS.
- **Optional:**
  - an SMTP mailbox or a Resend account, for invitations and password recovery;
  - a Meta app with WhatsApp Business, Messenger or Instagram access.

A small installation runs comfortably on 2 vCPUs and 4 GB of RAM, with PostgreSQL alongside.

---

## The database: what is automatic

**You do not create tables, columns or indexes by hand.** Every part of the database is created and upgraded by the application:

1. **`bootstrap`** connects with the PostgreSQL administrator login from your configuration. It creates two roles if they do not exist:
   - a **migration role**, which owns the schema;
   - a **runtime role**, which the application uses. It has only the rights it needs and cannot bypass row-level security.

   It then creates the application database if it is missing.
2. **`migrate`** applies every file in `packages/database/migrations/` that has not been applied yet, in order. It creates every table, index, constraint and row-level security policy. Each applied file is recorded with a checksum in `schema_migrations`. A lock ensures that two starts never migrate at the same time.

Both steps run in the `database` service (or with `pnpm db:bootstrap && pnpm db:migrate`). They are safe to run on every deployment: files already applied are skipped. A migration file that was changed after it was applied is refused, because migrations are forward-only.

What the application stores as **data** is created from the interface, never from the schema:
- custom contact fields and labels (**Contacts → Labels & custom fields**);
- teams, roles, channels, audiences and automations.

Adding a custom field in the app does not change the database schema.

---

## Configuration

All configuration is read from environment variables. Copy `.env.example` to `.env` and fill it in. Keep `.env` out of version control and out of the image.

Generate each secret separately:

```bash
openssl rand -hex 32                     # CONVO_AUTH_HASH_SECRET, CONVO_BOOTSTRAP_TOKEN, CONVO_IDEMPOTENCY_HASH_SECRET
echo "v1:$(openssl rand -base64 32)"      # CONVO_CREDENTIAL_KEYS
openssl rand -base64 24                  # each database password
```

### Required

| Variable | Example | Notes |
| --- | --- | --- |
| `CONVO_DEPLOYMENT_MODE` | `self_hosted_single` | `self_hosted_single` for one company, or `saas` for many. |
| `CONVO_INSTALLATION_NAME` | `DS Omnichannel` | Shown in the product and in emails. |
| `CONVO_PUBLIC_BASE_URL` | `https://inbox.example.com` | The public origin users open. Every link in every email is built from it. |
| `CONVO_DEFAULT_LOCALE` / `CONVO_SUPPORTED_LOCALES` | `ar` / `ar,en` | Interface languages. |
| `CONVO_AUTH_HASH_SECRET` | 64 hex characters | Keys session and token hashing. |
| `CONVO_BOOTSTRAP_TOKEN` | 64 hex characters | Needed once, to create the first company and owner. |
| `CONVO_IDEMPOTENCY_HASH_SECRET` | 64 hex characters | Keys the duplicate-request protection. |
| `CONVO_PG_HOST`, `CONVO_PG_PORT`, `CONVO_PG_DATABASE` | `postgres`, `5432`, `convo` | Where PostgreSQL is. |
| `CONVO_PG_SUPERUSER`, `CONVO_PG_SUPERPASSWORD` | `postgres`, … | Used **only** by the `database` step. |
| `CONVO_PG_MIGRATION_ROLE`, `CONVO_PG_MIGRATION_PASSWORD` | `convo_migration`, … | Created by `bootstrap`. |
| `CONVO_PG_RUNTIME_ROLE`, `CONVO_PG_RUNTIME_PASSWORD` | `convo_app`, … | Created by `bootstrap`; used by the API and workers. |
| `CONVO_TRUSTED_PROXY_HOPS` | `2` | Proxies in front of the API: your TLS proxy, then the `web` service. Use `1` if nothing sits in front of `web`. Getting this wrong puts every user in one login rate-limit bucket. |

### Per service

| Service | Variables |
| --- | --- |
| web | `CONVO_SERVICE_KIND=web`, `CONVO_API_ORIGIN=http://<api host>:3000`, `PORT` (default `4173`) |
| database | `CONVO_SERVICE_KIND=database` |
| api | `CONVO_PROCESS_ROLE=api`, `CONVO_API_HOST=0.0.0.0`, `CONVO_API_PORT=3000` |
| each worker | `CONVO_PROCESS_ROLE=<role>`, optionally `CONVO_WORKER_CONCURRENCY` (default `4`) |

### Optional features

| Variable | Purpose |
| --- | --- |
| `CONVO_CREDENTIAL_KEYS` | `v1:<base64 32 bytes>`. Encrypts channel credentials. Required before connecting any channel. Keep old keys in the comma-separated list when you rotate. |
| `CONVO_CHANNEL_TRANSPORT` | `none` (default; every send is refused visibly) or `meta` to send through Meta. |
| `CONVO_CHANNEL_SECRET_<REF>` | A Meta app secret. `<REF>` matches the secret reference saved with the channel app. |
| `CONVO_EMAIL_PROVIDER` and the related email variables | See [Email and notifications](#email-and-notifications). Only `worker-integration` needs them. |
| `CONVO_WEB_PUSH_PUBLIC_KEY`, `CONVO_WEB_PUSH_PRIVATE_KEY`, `CONVO_WEB_PUSH_SUBJECT` | Browser push notifications (VAPID). The public key goes to the API. All three go to `worker-integration`. |
| `CONVO_BROKER_URL` | A durable message broker for the integration relay. Leave it unset if you do not run one. |
| `CONVO_MFA_ENABLED` | `true` by default. |
| `CONVO_EMAIL_LOCALE` | `en` (default) or `ar`, for invitation and recovery emails. |
| `CONVO_LOG_LEVEL` | `info` (default) or `debug`. |

The process validates its configuration at start. If something is missing or malformed, it exits with a JSON log line naming the variable.

---

## Deploy with Docker Compose

[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) runs PostgreSQL, the migration step, the API, the web app and all six workers on one server.

```bash
git clone <your repository> convo && cd convo
cp .env.example .env              # fill in every value (see Configuration)
docker compose --env-file .env -f deploy/docker-compose.example.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.example.yml ps
```

- The web app listens on port **8080**. Point your TLS reverse proxy at it.
- Minimal Caddy configuration:

  ```
  inbox.example.com {
    reverse_proxy 127.0.0.1:8080
  }
  ```

- The `database` service runs on every `up` and exits once migrations are applied. The API and workers start only after it succeeds.
- To use a managed PostgreSQL instead:
  - remove the `postgres` service;
  - set `CONVO_PG_HOST` and `CONVO_PG_PORT` in `.env`;
  - delete the `CONVO_PG_HOST` and `CONVO_PG_PORT` overrides in `x-app-env`.

The same image can run on Kubernetes, ECS, Railway or any container platform. Create one service per row of the [service table](#architecture). Only `web` should be public.

---

## Deploy without Docker

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm build

set -a; source .env; set +a
pnpm db:bootstrap && pnpm db:migrate                         # every deployment, before starting anything

CONVO_PROCESS_ROLE=api node apps/api/dist/main.js
CONVO_SERVICE_KIND=web PORT=8080 CONVO_API_ORIGIN=http://127.0.0.1:3000 node apps/web/server.mjs
CONVO_PROCESS_ROLE=worker-inbound CONVO_API_PORT=3101 node apps/api/dist/main.js
CONVO_PROCESS_ROLE=worker-interactive CONVO_API_PORT=3102 node apps/api/dist/main.js
CONVO_PROCESS_ROLE=worker-campaign CONVO_API_PORT=3103 node apps/api/dist/main.js
CONVO_PROCESS_ROLE=worker-report CONVO_API_PORT=3104 node apps/api/dist/main.js
CONVO_PROCESS_ROLE=worker-automation CONVO_API_PORT=3105 node apps/api/dist/main.js
CONVO_PROCESS_ROLE=worker-integration CONVO_API_PORT=3106 node apps/api/dist/main.js
```

- Run each command under a process manager (systemd, pm2, supervisord) that restarts it on failure.
- Set `NODE_ENV=production`.
- Workers on the same host need distinct `CONVO_API_PORT` values, because that is the port of their health probe.

---

## First run: create the company and its owner

A new installation has no users. Create the company and its first **Owner** once, using the bootstrap token from your configuration:

```bash
curl -X POST https://inbox.example.com/api/v1/instance/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Token: $CONVO_BOOTSTRAP_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
        "companyName": "Digital School",
        "companySlug": "digital-school",
        "ownerEmail": "owner@example.com",
        "ownerPassword": "a long passphrase of 12+ characters"
      }'
```

- `GET /api/v1/instance` shows whether bootstrap is still required.
- A second bootstrap is refused.
- After this call:
  1. Sign in at `https://inbox.example.com` with the owner account.
  2. Invite the rest of the team from **Users**.
  3. Connect your channels from **Channels**.

---

## Connecting channels

All channels are connected from **Channels** in the app. Each needs `CONVO_CREDENTIAL_KEYS` to be set first.

- **WhatsApp, Messenger and Instagram.** Follow [`docs/runbooks/META_WHATSAPP.md`](docs/runbooks/META_WHATSAPP.md).
  1. Create or reuse a Meta app.
  2. Put its app secret in `CONVO_CHANNEL_SECRET_<REF>`.
  3. Set `CONVO_CHANNEL_TRANSPORT=meta`.
  4. Connect the number, page or account in the app.
  5. Point Meta's webhook at `https://<your domain>/api/v1/webhooks/meta/<app connection id>`.
- **Website chat.** Create the channel, then have your site's server post visitors' messages to the address shown on the channel, signed with its key.
- **Custom API channel.** Connect your own system with signed HTTP in both directions. The protocol is in [`docs/CUSTOM_CHANNEL.md`](docs/CUSTOM_CHANNEL.md).

WhatsApp broadcasts use templates approved in your WhatsApp Business account. Sync them from the broadcast wizard.

---

## Email and notifications

Email carries invitations and password-recovery links. Only `worker-integration` sends it. Configure that service with **one** of:

```bash
# SMTP (any provider; port 465 uses implicit TLS)
CONVO_EMAIL_PROVIDER=smtp
CONVO_EMAIL_FROM="Digital School <no-reply@example.com>"
CONVO_SMTP_HOST=smtp.example.com
CONVO_SMTP_PORT=465
CONVO_SMTP_SECURE=true
CONVO_SMTP_USERNAME=no-reply@example.com
CONVO_SMTP_PASSWORD=...

# or Resend
CONVO_EMAIL_PROVIDER=resend
CONVO_EMAIL_FROM="Digital School <no-reply@example.com>"
CONVO_RESEND_API_KEY=...
```

- With no provider, email is **disabled**: nothing is sent, and the app says so.
- `logging` is for development only and is refused in production.
- Verify the sender domain (SPF and DKIM) with your provider before going live.
- The full procedure is in [`docs/runbooks/EMAIL_DELIVERY.md`](docs/runbooks/EMAIL_DELIVERY.md).

**Browser push.** Generate a VAPID pair with `npx web-push generate-vapid-keys`.
- Give the public key to the API.
- Give all three push variables to `worker-integration`.

---

## Health checks and logs

| Service | Liveness | Readiness |
| --- | --- | --- |
| web | `GET /healthz` | `GET /healthz` |
| api | `GET /live` | `GET /ready` (checks PostgreSQL) |
| workers | `GET /live` on their `CONVO_API_PORT` | `GET /ready` after the first completed cycle |

- Use `/live` for restart policies. `/ready` depends on the database, so restarting on it would restart everything during a database blip.
- Every process writes structured JSON lines to stdout, one event per line. Ship them to your log platform.
- Alerting guidance is in [`docs/runbooks/ALERTING.md`](docs/runbooks/ALERTING.md).

---

## Upgrading

1. **Back up the database** and make sure the backup can be restored.
2. Deploy the new version to the `database` step first and wait for it to exit successfully. It applies any new migrations automatically.
3. Deploy the same version to `api`, then to every worker, then to `web`.
4. Check `/healthz` and `/ready`, then sign in and send a test message.

Migrations are forward-only. To undo a release, restore the backup taken in step 1 and redeploy the previous version.

---

## Backups and recovery

Your PostgreSQL database holds all application state. Back it up daily at minimum, for example:

```bash
pg_dump --format=custom --file=convo-$(date +%F).dump "postgresql://postgres:***@db-host:5432/convo"
```

- Keep copies off the server.
- Test a restore into a separate database regularly.
- Managed PostgreSQL services usually offer point-in-time recovery; turn it on.
- The full procedure is in [`docs/runbooks/DATABASE_RECOVERY.md`](docs/runbooks/DATABASE_RECOVERY.md).

---

## Local development

```bash
corepack enable && pnpm install
cp .env.example .env                    # point it at a local PostgreSQL
set -a; source .env; set +a
pnpm build && pnpm db:bootstrap && pnpm db:migrate
pnpm start:api                          # API on http://127.0.0.1:3000
pnpm start:web                          # Vite dev server; proxies /api to the API
```

The web app always calls `/api/v1` on its own origin. In development, Vite proxies it to `CONVO_API_ORIGIN`, which defaults to `http://127.0.0.1:3000`.

---

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit             # unit tests
pnpm test:integration      # API against a real, embedded PostgreSQL (no Docker needed)
pnpm test:coverage         # unit + integration + property, 100% line/branch/function coverage enforced
pnpm test:contracts        # API contract against docs/api/openapi.v1.json
pnpm test:security         # tenant isolation, authorization, signatures, dependency audit
pnpm exec playwright install chromium
pnpm test:e2e              # browser tests at 1440 and 1366
pnpm test:a11y
pnpm test:visual
```

---

## Documentation

| Topic | Where |
| --- | --- |
| API contract (OpenAPI 3) | [`docs/api/openapi.v1.json`](docs/api/openapi.v1.json) |
| Architecture and decisions | [`docs/architecture.md`](docs/architecture.md), [`docs/adr/`](docs/adr/) |
| Business rules and permissions | [`docs/product/business-rules.md`](docs/product/business-rules.md) |
| Broadcasts | [`docs/CAMPAIGN_ENGINE.md`](docs/CAMPAIGN_ENGINE.md) |
| Automations | [`docs/AUTOMATION_ENGINE.md`](docs/AUTOMATION_ENGINE.md) |
| Custom API channel | [`docs/CUSTOM_CHANNEL.md`](docs/CUSTOM_CHANNEL.md) |
| Runbooks: Meta, email, recovery, alerting, incidents | [`docs/runbooks/`](docs/runbooks/) |
| Portable handover checklist | [`docs/final/SOURCE_HANDOVER.md`](docs/final/SOURCE_HANDOVER.md) |

---

## Security notes

- **Secrets.** Keep them in your platform's secret store or in environment variables, never in the repository or the image. Rotate `CONVO_BOOTSTRAP_TOKEN` after the first run.
- **Database access.**
  - The runtime database role cannot bypass row-level security, so one company's data is isolated inside PostgreSQL itself.
  - Give the PostgreSQL administrator password only to the `database` step.
- **Channel credentials.** They are encrypted with AES-256-GCM under `CONVO_CREDENTIAL_KEYS` and are never returned to the browser.
- **Webhooks.** Every inbound webhook is signature-verified on the raw request body before it is stored.
- **Exposure.** Expose only the `web` service. The API, workers and PostgreSQL belong on a private network.
