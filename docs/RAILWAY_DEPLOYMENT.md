# Railway Deployment and Production Checklist

The executable topology and commands are maintained in
[runbooks/RAILWAY_PRODUCTION.md](./runbooks/RAILWAY_PRODUCTION.md). This file is
the release checklist for the client production environment.

## Required services

- Public web / reverse proxy
- Private API
- Private PostgreSQL with a persistent volume
- One-shot migration service
- Inbound, interactive, campaign and report workers
- **Integration worker** — email delivery lives here. **New; must be created.**
  Without it, no invitation or password-recovery email is ever sent.
- **Automation worker** — schedule materialization. **New; must be created.**
  Without it, no automation schedule is ever materialized (ADR-0018).
- Realtime role when SSE traffic is separated from the API

## Required secret groups

- Independent auth-hash, bootstrap, idempotency and credential-encryption keys
- Runtime and migration database roles and passwords
- **Email provider key and verified sender** — a production process will not
  start without them
- **`CONVO_TRUSTED_PROXY_HOPS=2`** — not optional on this topology; at the
  default the login rate limiter is one bucket shared by every user
- Meta app-secret references and access tokens, when channels are connected
- Public origin and allowed widget origins
- Broker credentials only when the broker relay is enabled

## Release order

1. Snapshot / back up PostgreSQL.
2. Deploy and run the one-shot migration service; require exit `0`.
3. Deploy the workers that understand the new schema.
4. Deploy API / realtime.
5. Deploy web.
6. Run public-origin session, CSRF, inbox, campaign and report smoke tests.
7. Run provider verification only with approved client assets.
8. Confirm queue age, error rate, database connections and worker leases.

## Go-live blockers

No go-live while any of these is true:

- **Email has never been sent through the configured provider.** The adapter and
  the outbox are built and tested; a real send has not happened.
- **`convo-worker-integration` or `convo-worker-automation` is not deployed.**
- **`CONVO_TRUSTED_PROXY_HOPS` is unset** on a topology where the browser reaches
  the API through the web service.
- **Provider transport is unconfigured**, or has never exchanged a real message
  with Meta.
- **The accept-invitation and reset-password screens do not exist.** Email links
  point at routes the SPA does not have.
- **A restore has not been drilled on the platform** with `pg_restore`.
- **The production owner cannot sign in through the public origin.**
- **Any migration checksum differs** from the recorded value.
- **The automation engine has no executor** — do not sell or enable Automations.

Current status against these: see
[audit/PRODUCTION_READINESS_REPORT.md](./audit/PRODUCTION_READINESS_REPORT.md).
The verdict there is **NO-GO for live traffic, GO for staging**.
