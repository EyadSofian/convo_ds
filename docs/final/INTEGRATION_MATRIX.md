# CONVO integration matrix

Audit date: 2026-09-19  
Code baseline: `main` at `3d5a2f9ef86c9f24c1d91e84f3ceda8f88e6d406`

`Contract-tested` and `live-verified` are intentionally separate. A provider is
not live merely because its signature parser or HTTP request builder passes.

| Integration | Implemented | Configured | Tested with mock/contract | Tested live | Client asset required | Remaining work |
| --- | --- | --- | --- | --- | --- | --- |
| WhatsApp Cloud API — inbound | Yes | No; transport disabled | Yes: raw signature, journal, normalization, identity scoping, dedupe, receipts and replay | No | Meta App ID/secret, WABA ID, Phone Number ID, verify token and long-lived system-user token | Real signed message must reach Inbox once with the correct identity and realtime event. |
| WhatsApp Cloud API — outbound | Yes: real Graph transport | No; `CONVO_CHANNEL_TRANSPORT=none` | Yes: template pagination, request, attempt-before-I/O, provider ID, ambiguity and receipt folding | No | Same assets, approved template and authorized test recipient | Prove agent reply and one-recipient automation with sent/delivered/read evidence where available. |
| Facebook Messenger — inbound | Yes | No | Yes: Meta signature boundary plus Messenger-specific normalization and policy | No; no authenticated owner asset was available | Meta app, Page ID/token, subscribed fields and controlled test account | Verify real Page inbound; do not present the channel as two-way. |
| Facebook Messenger — outbound | No | No | No claim | No | Approved Meta product/access | Implement a channel-specific Graph transport before any live reply claim. |
| Instagram Messaging — inbound | Yes | No | Yes: Meta signature boundary plus Instagram-specific normalization/policy | No; no authenticated owner asset was available | Meta app, Page and linked professional account IDs/tokens, controlled account | Verify a real DM and record the supported event matrix. |
| Instagram Messaging — outbound | No | No | No claim | No | Approved Instagram Messaging access | Implement a channel-specific transport before any live reply claim. |
| Website chat — signed ingress | Yes | Contract configuration only | Yes: HMAC timestamp/body, origin allowlist, replay, rate limit, normalization and dedupe | No deployed widget journey | Allowed origins, installation domain and product decision | Run production-domain ingress; invalid origin/signature must be rejected. |
| Website chat — browser widget/outbound | No finished package | No | No live embed claim | No | Approved embed UX, domains and key-provisioning policy | Build only if retained in MVP; then verify cross-browser send/receive/reconnect. |
| Custom channel API — inbound | Yes | Contract configuration only | Yes: HMAC, replay, normalization, dedupe and tenant scope | No named partner | Partner contract, network policy and signing-key exchange | Controlled partner event; duplicate and invalid signature must be rejected. |
| Custom channel API — outbound | Partial contract | No named partner | Dispatch contract only | No | Partner callback/API, auth and receipt vocabulary | Implement/verify outbound, receipt, retry and ambiguity semantics. |
| Resend email | Yes | No in production; logging only outside production | Yes: role config, fail-closed startup, outbox, retry, invitation and recovery | No | Verified sender/domain, `CONVO_EMAIL_FROM`, API key and test inbox | Prove invite and reset delivery, acceptance/reset, revocation and reuse denial. |
| PostgreSQL | Yes | Yes in internal staging/production | Yes: 32 migrations, forced RLS, isolation, recovery and load | Yes for normal operation and logical restore | Client database credentials, backup and retention policy for handover | Run an isolated native restore in each final hosting platform. |
| Durable broker relay | Optional port only | No | Yes: fail-closed and durable outbox behavior | No | Broker URL/credentials only if enabled | Prove confirmation/retry/poison recovery, or leave disabled. |
| Alert destination | Rules/runbook only | No | Rule-level evidence only | No | Named Slack, PagerDuty, Opsgenie, email or generic webhook target | Send safe warning and critical tests and inspect for secrets/PII. |
| CRM / Odoo | No; post-MVP | No | Architecture decision only | No | Vendor/version, API auth, mappings and conflict ownership | Scope and build only after a real contract exists. |
| Telegram | No; post-MVP | No | Unavailable-state UI test | No | Bot/API ownership and requested capabilities | Build adapter if approved; UI remains honestly unavailable. |
| TikTok | No; post-MVP | No | Custom-channel boundary only | No | Approved API product and scope | Build a capability-specific adapter if approved. |

## Provider activation rule

Activation requires an immutable source SHA, secrets supplied directly to the
target secret store, a named synthetic recipient/account, and retained evidence
without tokens, cookies, message bodies or customer identifiers. A mock, logging
adapter or test stub may prove internal behavior but can never satisfy the
`live evidence required` column.
