# CONVO — Provider evidence ledger

Every row separates **what a source said**, **when we observed it**, and **what we decided**. Nothing here is an account-specific fact; all account grants, quotas, tokens and pricing remain implementation-time verification against authorized assets.

## 1. Verification limits — read this first

| Item | Status as of 2026-09-07 |
|---|---|
| Meta app, WABA, phone number, Page, IG professional account | **Not supplied.** No connection, no send, no token. The WhatsApp adapter, the ingress, the credential store and the Channels screen are implemented and tested against fixtures; **no provider transport is configured at all**, so every send and every connection test refuses with `provider_not_connected`. |
| Odoo instance and service account | **Not supplied.** |
| Figma editable nodes | **Not accessible.** Connector unauthenticated; `WebFetch` of the Community page returned HTTP 403. |
| Several Meta documentation pages | Returned **HTTP 429** to text fetches during the v2 research. |
| Instagram messaging documentation | **Directly read in a browser** during v2 research (page dated 6 May 2026). |
| Chatwoot reference | Cached at pinned commit `c9f1867369ea87580adac3df9f2058bc63da1ef2`; licences read; **not executed**. |

Therefore: every `Live` status in the traceability registry is `blocked_no_asset` or `n/a`. The adapters, fixtures, policy engines and UI are **not** blocked by this and proceed at full scope.

**On simulators.** There is deliberately no provider simulator bound anywhere in the shipped composition root. A simulator that answered "accepted" would make the Channels screen show a working channel, and that would be a lie told by our own code rather than by a provider. The default transport refuses every call with a typed reason, and one integration suite binds a clearly-labelled **stub** to exercise our own success and failure handling — it produces no message id, claims no send, and exists only inside that test file.

**On the broker (added 2026-09-09).** The same rule now applies to the durable transport. The relay, publisher confirms, consumer idempotency, bounded retries, the dead-letter quarantine and the audited replay are all built and tested, against a **stub broker whose answer each test chooses**. That stub proves our own behaviour when a broker confirms, refuses, or goes quiet; it proves nothing about RabbitMQ, and it is bound nowhere outside its test file. No broker product is configured, so the shipped default answers every publish `unknown` with `broker_not_configured` — deliberately *unknown* rather than *refused*, so the outbox grows visibly instead of the system discarding events because nobody configured a transport. DEL-08 and DEL-09 therefore stay `blocked_env` on the live column: the code is done, the environment is not supplied.

**On realtime (added 2026-09-09).** Realtime needs no provider, so nothing here is blocked by the missing Meta assets — but it is worth recording what it is *not*. The feed carries what this installation observed: normalized inbound events, delivery receipts folded from provider webhooks, and assignment changes made by people. It contains no provider-reported fact that was not first verified by a signature and journaled. A subscriber watching a delivery tick move to `read` is watching a receipt this installation received and stored, not a claim the UI invented while waiting.

## 2. WhatsApp Cloud API

| Observation | Source | Decision in CONVO |
|---|---|---|
| Opt-in required, opt-out respected, 24-hour customer-service reply window, approved templates outside it, clear escalation path when automation is involved | [WhatsApp Business Policy](https://whatsappbusiness.com/policy/), checked 2026-09-07 | Window and consent are enforced at **permit time**, not draft time (DEL-11, CH-WA-05). Import never implies opt-in (CT-07). |
| Official Postman collection documents sending and WABA subscription, but contains **older examples** | [Meta WhatsApp collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) | Used as an operations reference. **No version number is copied from it into production** (ADR-0009). |
| Embedded Signup exists as an onboarding path with variants | [Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) | Implement Embedded Signup **and** a manual admin path for preexisting assets. Do not conflate variants or coexistence (CH-WA-03). |
| A "Direct Send" capability for service messages was announced | [Meta video](https://developers.meta.com/resources/videos/whatsapp-direct-send-api/) | **Feature-flagged off.** An announcement is not eligibility for a specific account and never generalizes to template-free marketing (CH-WA-07). |
| Throughput, portfolio rolling unique-recipient limits and template pacing are **different** limits | BSP references: [AWS throughput](https://docs.aws.amazon.com/social-messaging/latest/userguide/increase-message-throughput.html), [360dialog messaging limits](https://docs.360dialog.com/docs/resources/wabas/messaging-limits) | Modelled as separate configurable limits, each with observed value, provenance and effective date. **Provisional — BSP-derived, not Meta-authoritative** (CH-WA-06). |
| Identity: BSUIDs / phone-absent identities exist | [Twilio key concepts](https://www.twilio.com/docs/whatsapp/key-concepts), [WhatsApp usernames FAQ](https://faq.whatsapp.com/1131753190029163) | Contacts have nullable phone; identities are scoped with validity intervals and rotation (CT-01, CT-02). Provisional. |

**Pinned Graph version: `v21.0`**, set 2026-09-09 in `packages/domain/src/channels/capabilities.ts` as `PINNED_GRAPH_VERSION`. It is a **pin, not a claim about the latest supported version**: Meta's version pages returned HTTP 429 to text fetches during this work, so the number was chosen as a conservative, widely-supported version rather than read from a live page. Bumping it is a config change plus a fixture re-record plus a capability-matrix diff (ADR-0009), and the capability snapshot test fails if a bump changes the matrix without that. When a documentation page can actually be read, this row gets its source URL and observation date and the version is re-confirmed or moved.

**Webhook signature (CH-WA-02):** `X-Hub-Signature-256`, HMAC-SHA-256 over the exact raw request bytes, constant-time comparison, plus a 300-second replay window on `X-Hub-Timestamp` when the sender supplies one. Implemented in `packages/domain/src/channels/meta-signature.ts` and asserted against altered bytes, a wrong secret, a `sha1=` downgrade, a malformed digest and a stale timestamp. **This half is genuinely verified**: the test computes the signature exactly as the provider would, with the app secret the installation configures, so nothing about it is simulated. What remains unverified is only whether Meta's *live* deliveries match the documented scheme, which needs an authorized app.

## 3. Instagram

Directly read in a browser during v2 research — the strongest evidence we currently hold.

| Observation | Decision |
|---|---|
| Instagram Login path uses `graph.instagram.com`, an **Instagram User** access token, and scopes `instagram_business_basic` + `instagram_business_manage_messages` | A dedicated adapter configuration with its own host, token type and scope set (CH-IG-01) |
| Conversations are **customer-initiated**; standard 24-hour response window | Cold DM attempts are rejected with a typed reason, not queued (CH-IG-03) |
| Serving professional accounts the app does not own/manage requires **Advanced Access** | Recorded as an app-review dependency; no assumption that test-account behaviour generalizes (P3 gate) |
| The page's example used Graph **v26.0** | An **observed example only** — not proof of the latest supported version for every Meta product (ADR-0009) |

Source: [Instagram API with Instagram Login — messaging](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api), page dated 6 May 2026, read 2026-09-07.

**Facebook Login for Instagram is a separate adapter configuration** with its own scopes, fixtures and evidence. Nothing is shared across the two paths (CH-IG-02).

## 4. Messenger

| Observation | Source | Decision |
|---|---|---|
| Page-scoped recipient IDs, a correctly authorized Page access token, `pages_messaging`; documented window and eligible-message rules | [Meta Messenger collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api) | Independent adapter, independent policy engine. **WhatsApp templates are never reused here** (TPL-05, CH-MSG-01). |
| Human-agent style grants are for eligible human support | same | Never extends **bot** sending privileges (CH-MSG-03). |

## 5. Capabilities we explicitly refuse to advertise

Arbitrary cold Instagram DMs; unrestricted Facebook broadcasts; group chat; disappearing-message parity; message editing/deleting; historic import; calling; read receipts on channels that do not provide them. Each of these is a capability requiring evidence, account/version/region conditions, fixtures, UI states and a live check before it may be shown as available. **An unsupported receipt is `not_available` — never `false`, never `0%`.**

## 6. Odoo

| Observation | Source | Decision |
|---|---|---|
| Odoo 17 exposes its supported external RPC interface | [Odoo 17 external API](https://www.odoo.com/documentation/17.0/developer/reference/external_api.html) | Version-detected adapter dialect (CRM-01) |
| Odoo 19 introduces JSON-2 | [Odoo 19 external API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) | Second dialect behind the same port |
| Online subscription restrictions ≠ self-hosted constraints | — | Deployment type is discovered, not assumed (ADR-0010) |

## 7. Engineering references

| Reference | What we take from it |
|---|---|
| [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Row policies have an authorization context; owners and BYPASSRLS roles need care → separate runtime role, pooled-context tests (ADR-0003) |
| [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) | A unique constraint on a partitioned table must include the partition key → global dedupe needs its own structure |
| [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability) | Confirms and redelivery are part of the contract and do not excuse the consumer from idempotency (ADR-0004) |
| [Temporal — idempotency and durable execution](https://temporal.io/blog/idempotency-and-durable-execution) | Durable execution does not create end-to-end exactly-once across an external provider |
| [OWASP API Security 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) | Object/action authorization, resource consumption and SSRF drive the security suite |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Acceptance criteria for every screen, both directions |
| [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/) | Load gates expressed as thresholds, with offered vs achieved rates |
| [pgvector](https://github.com/pgvector/pgvector), [OpenSearch Arabic analyzer](https://docs.opensearch.org/latest/analyzers/language-analyzers/arabic/) | Hybrid Arabic retrieval design (ADR-0013) |
| [Chatwoot](https://github.com/chatwoot/chatwoot/tree/c9f1867369ea87580adac3df9f2058bc63da1ef2) — [root licence](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/LICENSE), [enterprise licence](https://github.com/chatwoot/chatwoot/blob/c9f1867369ea87580adac3df9f2058bc63da1ef2/enterprise/LICENSE) | Domain shape and operational lessons **only**; separate licences; no source copied (ADR-0001) |

## 8. Competitor observations (product decisions, not benchmarks)

From the v2 research: respond.io separates roles from additional restrictions, and separates dispatch completion from delivery success; its documentation restricts cancellation to *scheduled* broadcasts. Chatwoot markets campaigns and gates custom roles by plan. SleekFlow places API/webhooks/RBAC in a premium tier and bills messages separately.

**Our decisions:** permissions are action + scope + field policy enforced by the API; a campaign screen is backed by a real recipient/attempt ledger with separate dispatch and delivery counters; we support stopping **not-yet-dispatched** work while stating plainly that a request already sent to a provider cannot be recalled; and platform entitlements are displayed separately from Meta's limits and fees. We do not claim any of these behaviours were copied from, or benchmarked against, those products.
