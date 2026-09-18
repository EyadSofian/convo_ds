# Railway environment matrix

Audited by variable name only on 2026-09-17. Secret values were never printed
or copied into this repository.

| Concern | staging | production |
| --- | --- | --- |
| Environment | `staging` (`6c7d3ce1-db61-40fd-9cf7-bffac954eda5`) | `production` (`ea473c79-c29e-4aab-91c4-e48f606dc057`) |
| Public web | `convo-client-demo-staging.up.railway.app` | `convo-client-demo-production.up.railway.app` |
| PostgreSQL | isolated service and volume; schema 0032 | existing volume healthy; schema unexpectedly advanced to 0032 by shared source trigger on 2026-09-18 |
| Email | `logging`, explicitly non-production | **BLOCKED:** `CONVO_EMAIL_PROVIDER`, `CONVO_EMAIL_FROM`, and `CONVO_RESEND_API_KEY` absent |
| Meta transport | `none`; contract tests only | **BLOCKED:** no authorized Meta asset/app evidence and no live transport configuration |
| Broker | absent | absent; integration relay remains fail-closed if armed without a broker |
| Automation worker | service created and configured | release attempt failed closed; not activated |
| Integration worker | service created and configured | release attempt failed closed; provider values absent; not activated |
| Trusted proxy | API set to two hops and observed at startup | API set to two hops; release API failed healthcheck |
| Platform backups/PITR | `enabled: false`; logical restore drilled separately | enabled; bucket wired; daily + weekly schedules and pre-release backup created |
| Railway healthcheck config | API/workers `/ready`, web `/healthz`, 120s | release web healthy; release API/workers failed closed and are not activated |

On 2026-09-18 every staging application artifact was built from
`EyadSofian/convo_ds` at `eac8b262c5b6eadf3289327ce1bbabd40249a7dc`.
Railway's GitHub source is associated at service scope and created triggers in
production as well as staging. After the unintended production migration, all
nine application source associations were disconnected to prevent recurrence.
The running staging deployments remain traceable to the commit in deployment
metadata; automatic GitHub redeploy is intentionally disabled pending an
environment-isolated topology or an explicit staging-only release workflow.

Shared database, installation, locale, cryptographic, and role variables are
present in the existing production API and workers. The two new production
workers now have matching core contracts and explicit role selectors.
Production activation must not continue until real provider values are supplied
by their owner, all workers have the complete validated environment, and the
cross-environment deployment isolation defect is resolved.

Staging intentionally uses `NODE_ENV=staging` with the logging email adapter.
That permits full product-flow validation without pretending to send email.
It is not an acceptable production configuration.

## Service-by-service variable contract

`configured` was audited by key only. Secret values are not recorded here.

| Service | Variable/group | Required | staging | production | Secret | Source / validation |
| --- | --- | --- | --- | --- | --- | --- |
| API | PostgreSQL host/port/database/runtime role/password | yes | configured | configured | password | Railway reference; port numeric; runtime role non-owner |
| API | auth hash, idempotency hash, bootstrap token | yes | configured | configured | yes | operator; minimum 32 bytes |
| API | credential encryption keys | channel use | configured | configured | yes | versioned AES-256 key list |
| API | `CONVO_PUBLIC_BASE_URL` | yes | staging URL | configured | no | absolute HTTPS in production |
| API | `CONVO_TRUSTED_PROXY_HOPS` | Railway | `2` | pending exact release deploy | no | integer 0–8; topology verified as edge + web proxy |
| API | `CONVO_PROCESS_ROLE` / `CONVO_SERVICE_KIND` | yes | `api` | configured | no | closed role enum |
| Web | `CONVO_API_ORIGIN` | yes | private API origin | configured | no | Railway private HTTP origin |
| Migration | superuser/migration/runtime PostgreSQL variables | yes | configured | configured | yes | used only by one-shot migration role |
| Inbound worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-inbound` |
| Interactive worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-interactive` |
| Campaign worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-campaign` |
| Report worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-report` |
| Integration worker | runtime DB, role, email provider/from/key | yes | logging only | provider values missing | provider key | production must be `resend`; logging is rejected in production |
| Automation worker | runtime DB + shared crypto/config + role | yes | configured | shared app values missing | mixed | role `worker-automation` |
| Provider channels | Meta app secret/access token/WABA/phone/verify token | live WhatsApp | absent | absent | yes | authorized Meta assets; never browser-visible |
| Optional broker | broker URL/credentials | only if broker enabled | absent | absent | yes | workers remain PostgreSQL-durable; integration relay fails closed if armed |
