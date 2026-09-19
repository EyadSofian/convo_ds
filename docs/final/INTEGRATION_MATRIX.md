# CONVO integration matrix

Audit date: 2026-09-19  
Code baseline: `main` at `3d5a2f9ef86c9f24c1d91e84f3ceda8f88e6d406`

`Contract-tested` and `live-verified` are intentionally separate. A provider is
not live merely because its signature parser or HTTP request builder passes.

| Integration | Direction | Product state | Automated evidence | Client-owned input | Live evidence required | Safe state now |
| --- | --- | --- | --- | --- | --- | --- |
| WhatsApp Cloud API | inbound | Implemented; awaiting live proof | Raw-body signature, journal, normalization, identity scoping, dedupe, receipts and replay tests | Meta App ID/secret, WABA ID, Phone Number ID, verify token, long-lived system-user token | Real signed message reaches Inbox once with correct identity and realtime event | Transport disabled; no synthetic success |
| WhatsApp Cloud API | outbound | Real Graph transport implemented; awaiting live proof | Template sync pagination, send request, attempt-before-I/O, provider ID, ambiguity and receipt folding tests | Same assets plus approved template and authorized test recipient | Agent reply and one-recipient automation show provider ID, sent, delivered and read when available | `CONVO_CHANNEL_TRANSPORT=none` |
| Messenger | inbound | Adapter implemented; awaiting live proof | Shared Meta signature boundary plus Messenger-specific normalization and policy tests | Meta app, Page ID/token, subscribed webhook fields and test account | Real Page message appears once and replies remain disabled until outbound exists | Connection must not be presented as fully two-way |
| Messenger | outbound | Not implemented | None claimed | Approved Meta product/access | Implement transport, then controlled recipient proof | Explicitly unavailable |
| Instagram Messaging | inbound | Adapter implemented; awaiting live proof | Meta signature boundary plus Instagram-specific normalization/policy tests | Meta app, Page and linked professional account IDs/tokens, test account | Real DM appears once; supported event matrix recorded | Connection must not be presented as fully two-way |
| Instagram Messaging | outbound | Not implemented | None claimed | Approved Instagram Messaging access | Implement transport, then controlled recipient proof | Explicitly unavailable |
| Website chat | inbound | Signed server boundary implemented; widget missing | HMAC timestamp/body signature, origin allowlist, replay, rate-limit, normalization and dedupe tests | Allowed origins, installation domain and visual/identity decision | Production-domain request accepted once; bad origin/signature rejected | No installable snippet issued |
| Website chat | browser widget/outbound | Not implemented as a finished package | No live embed claim | Approved embed UX, domains and key provisioning policy | Cross-browser install, send/receive, reconnect and key rotation | Keep out of client promise unless separately scoped |
| Custom channel API | inbound | Versioned signed ingress implemented | HMAC, replay, normalization, dedupe and tenant-scoping tests | Partner endpoint contract, origin/network policy and signing-key exchange | Partner sends controlled event; duplicate and invalid signature rejected | Available only as a documented integration boundary |
| Custom channel API | outbound | Partial contract; no named partner verification | Dispatch contract tests only | Partner callback/API, authentication and receipt vocabulary | Controlled outbound plus receipt/retry/ambiguity proof | Do not claim live connectivity |
| Resend email | outbound | Adapter implemented; awaiting live proof | Role-scoped config, production fail-closed, outbox, retry, invitation and recovery tests | Verified sender/domain, `CONVO_EMAIL_FROM`, API key and test inbox | Invite delivery/accept/reuse denial; reset delivery/reset/session revocation/reuse denial | Production provider disabled; logging only outside production |
| PostgreSQL | bidirectional persistence | Implemented | 32 migrations, forced RLS, isolation, recovery and load suites | Production credentials, backup policy and retention decision | Environment health plus approved isolated restore drill | Source supports any PostgreSQL 17-compatible managed/self-hosted target |
| Durable broker | outbound integration relay | Optional port implemented; not configured | Fail-closed behavior and durable outbox tests | Broker URL/credentials only if relay is enabled | Publish confirmation, retry and poison-message recovery | Leave unset; PostgreSQL queues remain authoritative |
| Alert destination | outbound | Rules/runbook exist; destination absent | Rule-level tests/runbook | Named Slack/PagerDuty/Opsgenie/email/generic webhook endpoint | Safe warning and critical notification with secret/PII inspection | No false claim of paging coverage |
| CRM / Odoo | bidirectional | Post-MVP / not implemented | Architecture decision only | Vendor/version, API auth, mapping and conflict ownership | Full sandbox contract and reconciliation tests | No connector shown as available |
| Telegram | bidirectional | Post-MVP / not implemented | UI unavailable-state test | Bot/API ownership and requested capabilities | Adapter contract then live bot test | Displayed as unavailable |
| TikTok | bidirectional | Post-MVP / not implemented | Custom-channel escape hatch only | Approved TikTok API product and scope | Capability-specific adapter and live test | No TikTok claim |

## Provider activation rule

Activation requires an immutable source SHA, secrets supplied directly to the
target secret store, a named synthetic recipient/account, and retained evidence
without tokens, cookies, message bodies or customer identifiers. A mock, logging
adapter or test stub may prove internal behavior but can never satisfy the
`live evidence required` column.
