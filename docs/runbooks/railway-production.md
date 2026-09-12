# Railway production topology

The production workspace uses one public origin and private service-to-service networking.

| Service | Exposure | Process |
| --- | --- | --- |
| `convo-client-demo` | Public | Static web server and same-origin `/api` reverse proxy |
| `convo-api` | Private | `CONVO_PROCESS_ROLE=api` on port 3000 |
| `convo-worker-inbound` | Private | Inbound normalization and lifecycle jobs |
| `convo-worker-interactive` | Private | Interactive outbound dispatch |
| `convo-worker-campaign` | Private | Campaign recipient dispatch |
| `convo-worker-report` | Private | Asynchronous campaign CSV exports |
| `Postgres` | Private | Persistent PostgreSQL volume |
| `convo-database` | One-shot | Cluster bootstrap and forward-only migrations |

The browser talks only to `https://convo-client-demo-production.up.railway.app`. The web server streams `/api/*` to `http://convo-api.railway.internal:3000`, preserving cookies, request bodies, response headers and SSE. The API and workers reach PostgreSQL through Railway reference variables. Neither API nor PostgreSQL has a public domain.

## Deploy

Every service uses the root `Dockerfile`. `deploy/start.sh` selects web, database or API/worker execution from `CONVO_SERVICE_KIND`; API and worker selection remains solely `CONVO_PROCESS_ROLE`.

Apply database changes before deploying code that needs them:

```bash
railway up --service convo-database --environment production --detach
railway up --service convo-api --environment production --detach
railway up --service convo-worker-inbound --environment production --detach
railway up --service convo-worker-interactive --environment production --detach
railway up --service convo-worker-campaign --environment production --detach
railway up --service convo-worker-report --environment production --detach
railway up --service convo-client-demo --environment production --detach
```

`convo-database` is expected to exit successfully after reporting either every applied migration or `no pending migrations`. A migration checksum mismatch is a failed deployment and must be fixed with a new forward-only migration.

## Required operator assets

The deployment deliberately has no Meta credentials and no live provider transport yet. Connecting WhatsApp, Messenger or Instagram requires an authorized Meta App ID, App Secret reference, access token and the relevant Phone Number/Page/Instagram Account IDs. Add those as Railway secrets and channel records; never commit them.

The durable broker-backed integration relay remains undeployed because no broker is configured. Core inbound, interactive, campaign and report work is running from the PostgreSQL durable queues. CRM integration is deferred until the customer's CRM and field contract are supplied.

## Production verification

Verify the public health endpoint, installation descriptor and a real owner session through the public origin. Then read memberships, channels, campaigns, campaign reporting, people and inbox through the authenticated session. Check every deployed service reports `SUCCESS`; the one-shot database service should report a completed successful deployment with zero running replicas.
