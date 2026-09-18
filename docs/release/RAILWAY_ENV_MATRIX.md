# Railway environment matrix

Audited by variable name only through 2026-09-18. Secret values were never printed
or copied into this repository.

| Concern | staging | production |
| --- | --- | --- |
| Environment | `staging` (`6c7d3ce1-db61-40fd-9cf7-bffac954eda5`) | `production` (`ea473c79-c29e-4aab-91c4-e48f606dc057`) |
| Public web | `convo-client-demo-staging.up.railway.app` | `convo-client-demo-production.up.railway.app` |
| PostgreSQL | isolated service and volume; schema 0032 | healthy attached volume; schema 0032 after the cross-environment incident |
| Email | `logging`, explicitly non-production | **BLOCKED:** `CONVO_EMAIL_PROVIDER`, `CONVO_EMAIL_FROM`, and `CONVO_RESEND_API_KEY` absent |
| Meta transport | `none`; contract tests only | **BLOCKED:** no authorized Meta asset/app evidence and no live transport configuration |
| Broker | absent | absent; integration relay remains fail-closed if armed without a broker |
| Automation worker | service created and configured | variable contract and `worker-automation` role staged; first deployment withheld |
| Integration worker | service created and configured | variable contract and `worker-integration` role staged; provider values absent and first deployment withheld |
| Trusted proxy | API set to two hops and observed at startup | API set to two hops; deploy pending release promotion |
| Platform backups/PITR | `enabled: false`; logical restore drilled separately | enabled; bucket wired; daily + weekly schedules and pre-release backup created |
| Railway source | disconnected; immutable CLI deployment only | disconnected; immutable manual deployment only |
| Railway healthcheck config | API/workers `/ready`, web `/healthz`, 120s | API/workers `/ready`, web `/healthz`, 120s |

Shared database, installation, locale, cryptographic, and role variables are
present in the existing production API and workers. The two new production
workers now have matching core contracts and explicit role selectors.
Core production recovery does not require provider values. Provider-dependent
worker activation remains blocked until its own complete contract is present.

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
| API | Resend provider/from/key | no | ignored by role | not required for core boot | yes | API writes durable outbox rows; it never calls Resend |
| Web | `CONVO_API_ORIGIN` | yes | private API origin | configured | no | Railway private HTTP origin |
| Migration | superuser/migration/runtime PostgreSQL variables | yes | configured | configured | yes | used only by one-shot migration role |
| Inbound worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-inbound` |
| Interactive worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-interactive` |
| Campaign worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-campaign` |
| Report worker | runtime DB + shared crypto/config + role | yes | configured | configured | mixed | role `worker-report` |
| Integration worker | runtime DB + role | yes | configured | configured | mixed | may boot with provider explicitly disabled |
| Integration worker | email provider/from/key | when Resend enabled | logging only | provider values missing | provider key | production logging is rejected; disabled mode refuses with `email_provider_not_configured` |
| Automation worker | runtime DB + shared crypto/config + role | yes | configured | shared app values missing | mixed | role `worker-automation` |
| Provider channels | Meta app secret/access token/WABA/phone/verify token | live WhatsApp | absent | absent | yes | authorized Meta assets; never browser-visible |
| Optional broker | broker URL/credentials | only if broker enabled | absent | absent | yes | workers remain PostgreSQL-durable; integration relay fails closed if armed |

## Worker deployment policy

| Role | Class | Safe without Meta | Safe without Resend | Deploy during core recovery |
| --- | --- | --- | --- | --- |
| `worker-inbound` | provider-required | idle with no signed inbound | yes | no |
| `worker-interactive` | provider-required | refuses transport explicitly | yes | no |
| `worker-campaign` | provider-required | refuses transport explicitly | yes | no |
| `worker-report` | optional | yes | yes | no; not needed for API recovery |
| `worker-integration` | provider-required | broker path independently disabled | typed email refusal when disabled | no |
| `worker-automation` | optional/provider-adjacent | outbound steps refuse explicitly | yes | no |

Only API and web are required to restore core availability. Workers are enabled
deliberately after their queues and provider contracts are reviewed; a source
push never deploys them automatically.
