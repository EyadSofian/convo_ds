# Railway topology

## Intended release topology

| Service | Exposure | Process role | Verified staging state |
| --- | --- | --- | --- |
| `convo-client-demo` | public | web proxy/static app | deployed successfully |
| `convo-api` | private | `api` | deployed; `/live` and `/ready` 200 |
| `convo-database` | private one-shot | migration/bootstrap | applied 32 migrations |
| `convo-worker-inbound` | private | `worker-inbound` | deployed; all probes 200 |
| `convo-worker-interactive` | private | `worker-interactive` | deployed; all probes 200 |
| `convo-worker-campaign` | private | `worker-campaign` | deployed; all probes 200 |
| `convo-worker-report` | private | `worker-report` | deployed; all probes 200 |
| `convo-worker-integration` | private | `worker-integration` | deployed; logging email drained |
| `convo-worker-automation` | private | `worker-automation` | deployed; all probes 200 |
| `Postgres` | private | PostgreSQL 18 image | isolated volume; restore drilled |

Only the web service owns a public domain. It proxies same-origin `/api/*` to
`convo-api.railway.internal:3000`; PostgreSQL, the API, and workers remain on
Railway private networking. Every app/worker deploy uses the same Docker image,
with `CONVO_SERVICE_KIND` and `CONVO_PROCESS_ROLE` selecting the entry point.

The production environment and its database volume were not changed during
staging creation. Railway created a separate staging PostgreSQL volume mounted
at `/var/lib/postgresql/data`.

Railway now persists `/ready` for the API and all six workers, and `/healthz`
for web, each with a 120-second timeout. A GraphQL read-back confirmed every
path is non-null while the corresponding deployment remains `SUCCESS`.
Production remains on its prior application topology; the two new production
workers have not yet been deployed.
