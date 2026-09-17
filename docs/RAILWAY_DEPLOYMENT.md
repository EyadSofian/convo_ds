# Railway Deployment and Production Checklist

The executable topology and commands are maintained in [runbooks/railway-production.md](./runbooks/railway-production.md). This file is the release checklist for the client production environment.

## Required services

- Public web/reverse proxy
- Private API
- Private PostgreSQL with persistent volume
- One-shot migration service
- Inbound, interactive, campaign and report workers
- Realtime role when SSE traffic is separated from API
- Automation/SLA worker when those migrations ship

## Required secret groups

- Independent auth hash, bootstrap, idempotency and credential-encryption keys
- Runtime and migration database roles/passwords
- Meta app secret references and access tokens
- Email provider key and verified sender
- Public origin and allowed widget origins
- Broker credentials when broker relay is enabled

## Release order

1. Snapshot/backup PostgreSQL.
2. Deploy and run the one-shot migration service; require exit `0`.
3. Deploy workers that understand the new schema.
4. Deploy API/realtime.
5. Deploy web.
6. Run public-origin session, CSRF, inbox, campaign and report smoke tests.
7. Run provider verification only with approved client assets.
8. Confirm queue age, error rate, database connections and worker leases.

## Go-live blockers

No go-live while email delivery is a logging adapter, provider transport is unconfigured, backup restore is untested, the production owner cannot sign in through the public origin, or any migration checksum differs from the recorded value.
