# CONVO — Business rules

Derived from MASTER-PROMPT §3, §4, §7, §16, §17, §18. This document is the implementation-facing restatement: every rule here must be enforced by a database constraint, a domain service, an authorization policy or a worker — never only by the UI.

Any change to a rule in this file requires an ADR plus updated tests. A frontend decision cannot change a rule here.

## 1. Vocabulary — words we refuse to overload

| Term | Definition | Not to be confused with |
|---|---|---|
| **User** | A global human identity (email/credentials/MFA) | Membership |
| **Membership** | That identity's access to exactly one company | User, Role |
| **Tenant / Company** | The isolation boundary owning all business data | Installation |
| **Installation** | One deployed CONVO instance (SaaS = many tenants; self-hosted = one) | Tenant |
| **Role** | A named bundle of permission keys | Scope |
| **Scope** | Which objects a granted action may touch (Tenant / Scoped / Own) | Role |
| **Channel connection** | An external provider asset we are authorized to use (a WhatsApp phone, a Facebook Page, an Instagram professional account) | Inbox |
| **Inbox** | The internal team work queue that a connection feeds | Channel connection |
| **Contact** | A person in a tenant, stable internal ID, phone nullable | External identity |
| **External identity** | `(provider, scope_type, scope_id, external_id, validity interval)` | Contact |
| **Conversation** | One support thread in one inbox for one contact identity | Contact history |
| **Message** | One customer-visible item | Private note |
| **Private note** | Internal-only item; has no send command and never reaches a provider | Message |
| **Send command** | Our durable intent to send | Delivery |
| **Delivery attempt** | One external request | Send command |
| **Receipt** | Provider-reported delivery/read evidence | Our command state |
| **Campaign** | The definition | Execution |
| **Execution** | The single, immutable run bound to one launched revision | Campaign |

A WhatsApp phone, a Facebook Page and an Instagram account have **separate connection IDs**. Never reuse one identifier for an inbox, a provider asset and a company.

## 2. Actor journeys (the ones that must actually work end to end)

1. **Installer (self-hosted)** — supplies config → installer validates env + callback reachability → migrations applied once → one-use bootstrap secret creates the single company and its Owner → bootstrap disables itself. No default password ever exists.
2. **Platform operator (SaaS)** — provisions a tenant, sets quotas/placement, suspends/reactivates, watches health. Cannot read a conversation. Support access, if granted at all, is scoped, reasoned, expiring (default max 60 min), MFA-gated, bannered and audited.
3. **Owner** — connects channels, defines roles/teams, invites people, sets consent/retention policy, approves large campaigns, transfers ownership (fresh MFA), requests company deletion.
4. **Supervisor** — watches the scoped inbox queues, reassigns, overrides routing inside scope, reads scoped reports.
5. **Agent** — sees a *projected queue card* for unassigned conversations in allowed inboxes, claims one atomically, then reads the full timeline, replies inside the channel window, writes private notes, snoozes, resolves.
6. **Campaign manager** — builds an audience, picks an approved template revision, dry-runs, requests approval, launches, watches the recipient ledger, pauses/cancels, retries only failed recipients.
7. **Integration developer** — configures Odoo mappings and webhook subscriptions, mints API keys **only within a delegation ceiling**, and gets no customer data by virtue of holding the key.
8. **Analyst** — reads tenant aggregates. No conversation content.
9. **Customer** — messages the business on WhatsApp/Messenger/Instagram, gets a reply from a human or (later) a bot, can ask for a person, can opt out.

## 3. Global invariants

These hold at all times, in both deployment modes.

- **I1** Every tenant-owned row has a non-null `tenant_id`, and every cross-entity reference is a composite FK including `tenant_id`.
- **I2** No request-supplied value (body, query, header, Host) may select or widen a tenant. Tenant comes from an authenticated membership, a verified channel asset, or the installation config.
- **I3** Effective access = action grant ∩ resource scope ∩ active membership ∩ inbox access ∩ field policy ∩ credential/support ceiling. Default deny.
- **I4** A hidden button is not an authorization control. Every check exists server-side.
- **I5** A durable accepted command is never lost, and never silently duplicated in its *internal effect*. End-to-end exactly-once through a provider is not claimed.
- **I6** Acceptance by a provider is not delivery. Delivery is not read. An unsupported receipt is `not_available`, never `false` or `0%`.
- **I7** `outcome_unknown` is a first-class outcome. It is never rendered as success and never blindly retried.
- **I8** Suppression beats consent. Stale CRM data never clears suppression. Import never implies opt-in.
- **I9** Approved campaign content is rendered from the approved snapshot, never from a live CRM field at send time.
- **I10** One campaign ID has at most one execution, permanently bound to the revision chosen at first launch.
- **I11** Private notes and their attachments never reach a provider or an unauthorized participant.
- **I12** Ownership (bot/human), read state, and provider delivery state are three independent dimensions.
- **I13** Money is exact decimal minor units with an explicit currency. Never binary floating point.
- **I14** All timestamps stored UTC; all schedules carry an IANA timezone; DST behaviour is explicit.

## 4. Conversation lifecycle

States: `open`, `pending`, `snoozed`, `resolved`, plus archived history.
**Active** = `open` ∪ `pending` ∪ `snoozed`.

**Uniqueness rule:** at most one non-archived active conversation per `(tenant_id, inbox_id, contact_identity_id)`, enforced by a partial unique index or a serialized transaction — not by "find then create".

| Trigger | From | To | Required side effects |
|---|---|---|---|
| First eligible customer inbound | — | open | Create conversation + message atomically; route; start first-response clock |
| Customer inbound | open | open | Append once; advance unread/event cursor; update reply clock per SLA policy |
| Agent marks waiting-for-customer | open | pending | Record actor + reason; pause resolution clock only if configured |
| Customer inbound | pending | open | Clear waiting reason; resume eligible clocks |
| Agent snoozes with future time | open/pending | snoozed | Store UTC wake time + source timezone; schedule durable versioned wake job |
| Wake time reached, or customer inbound | snoozed | open | Invalidate the old wake job; notify assigned team once |
| Resolve with required disposition | open/pending/snoozed | resolved | Record resolution event; cancel obsolete timers; unread is not silently marked read |
| New inbound on latest non-archived resolved thread | resolved | open | Reopen the same thread; start a **new reporting episode**; keep the original episode's metrics |
| New inbound after archival | archived | new open thread | Preserve link to history; never mutate an archived thread |
| Duplicate event / receipt / typing / private note | any | unchanged | These never reopen a conversation |
| Campaign outbound with no active thread | none/resolved | unchanged | Record outbound contact activity only; the customer's reply is what opens/reopens support |

Additional rules:

- A reply alone does not resolve a conversation.
- An ineligible reply (expired window, disconnected channel) fails with a typed error, changes no conversation state, and **does not erase the draft**.
- Unread is per user, computed from that user's last visible committed message cursor. Reading updates only that user's cursor. Customer delivery/read receipts are a different thing entirely.
- Writing a private note does not mark a customer reply delivered and does not reset the channel window.
- Provider message IDs are deduped **in their actual asset scope**. Echoes correlate to existing outbound messages.

### 4.1 Claim and ownership

- An Agent with `conversation.unassigned.preview` sees only: conversation ID, inbox/channel label, masked display label, priority, status, wait time, claim availability. No snippet, no timeline, no notes, no attachments, no contact PII. This is a **projected endpoint and projected socket payload**, not a full record with fields hidden in the browser.
- `conversation.read` grants full permitted content only **after** a successful claim or existing participation.
- Claim is atomic and version-checked: exactly one winner, the loser receives `CONVERSATION_VERSION_CONFLICT`.
- Losing inbox access overrides assignment and participation immediately.
- A reassigned queue card disappears or becomes a redacted "no longer available" card. It never becomes another agent's private timeline.

## 5. Campaign lifecycle

Control states: `draft → validating → ready → scheduled|running → pausing → paused → running → dispatch_completed`, with `cancelling → cancelled` and `failed` for terminal orchestration failure.

- Approval is a **separate, revision-bound record**. `ready` does not mean approved.
- Validation failure returns to `draft` with a report.
- Schedule is editable only in pre-launch `draft`/`ready`; a change requires fresh validation and approval.
- **`POST /launch` immediately creates the one execution, even when the approved send time is in the future.** The execution becomes `scheduled` (or `running` if due now). At the due time the scheduler activates *this existing* execution using *its bound revision*. It never picks a newer revision and never creates a second execution.
- In `scheduled`/`running`/`pausing`/`paused`/`dispatch_completed`/`cancelling`/`cancelled`/post-launch `failed`, edits to audience, content, variables, schedule, expiry and budget are **rejected**. To change a scheduled campaign: cancel, then clone. The cancelled ID is never reusable.
- A new run requires cloning to a new campaign ID. Cloning copies definition only — never execution state, prior approvals or idempotency results.
- Repeated launch returns the original execution under the idempotency contract, or a typed state conflict. It never sends again.
- Operators may **lower** a runtime rate/concurrency ceiling or hit a kill switch, with audit. They can never raise the approved budget, extend expiry, widen the audience or change content.

### 5.1 Terminal-state honesty

- `dispatch_completed` = every recipient reached a dispatch-terminal result: accepted, permanently failed, skipped, cancelled, or explicitly recorded `outcome_unknown`. Receipts may still arrive later.
- `cancelled` = no new dispatch permits remain and in-flight requests are accounted for. It does **not** mean nobody received anything.
- Attempt history is immutable after retry and after cancellation.

### 5.2 Audience and eligibility

- The audience snapshot is fixed at validation/final preparation, with a **visible timestamp**. It is not a live segment re-evaluated later.
- Adding a contact afterwards does not silently include them. Refreshing the audience creates a new revision and invalidates approval.
- Eligibility is recorded twice: at snapshot, and again at dispatch. Dispatch-time recheck covers consent withdrawal, updated suppression, template pause, expired schedule, exhausted budget, revoked channel and campaign stop version.

### 5.3 Budget

Estimated, reserved, committed and reconciled usage are four distinct quantities. Reservations release **exactly once** for skipped/cancelled recipients and stay held for `outcome_unknown` until reconciliation. Where provider pricing is variable, use a documented upper-bound estimate; if no safe budget decision is possible, **pause** rather than claim a guaranteed hard spend cap. Provider billing is authoritative only after reconciliation.

## 6. Consent and suppression

- An opt-in grant carries: source, proof reference, purpose/channel scope, timestamp, actor.
- Suppression is independent of CRM fields and wins over stale consent.
- Importing a phone list never implies opt-in. Ever.
- STOP/UNSUBSCRIBE and configured Arabic equivalents apply under a **documented matching policy**. Ambiguous keyword matching never *grants* consent; at worst it errs toward suppression and review.
- Manual opt-out records are supported.
- Removing suppression requires a new explicit permitted opt-in workflow, plus audit. There is no "unsuppress" button.

## 7. Role and scope matrix (product design, not a competitor copy)

`Tenant` = all objects in the company. `Scoped` = explicitly allowed teams/inboxes. `Own` = assigned/participating conversations inside allowed inboxes. `No` = denied.

| Capability | Owner | Admin | Supervisor | Agent | Campaign Mgr | Analyst | Integration Dev |
|---|---|---|---|---|---|---|---|
| Read full conversation timeline | Tenant | Tenant | Scoped | Own | No | No | No |
| Reply / private note | Tenant | Tenant | Scoped | Own | No | No | No |
| View unassigned / claim | Tenant | Tenant | Scoped | Scoped | No | No | No |
| Assign others / override routing | Tenant | Tenant | Scoped | No | No | No | No |
| Close / reopen / snooze | Tenant | Tenant | Scoped | Own | No | No | No |
| Edit contact business fields | Tenant | Tenant | Scoped | Own conversation's contact | Scoped campaign contacts | No | No |
| Merge / export contacts | Tenant | Tenant | Extra grant | No | Extra grant | No | No |
| View consent / suppression | Tenant | Tenant | Scoped | Own conversation's contact | Scoped | Aggregates only | No |
| Record opt-out | Tenant | Tenant | Scoped | Own conversation's contact | Scoped | No | No |
| Draft / validate campaign | Tenant | Tenant | No | No | Scoped | No | No |
| Approve campaign | Tenant (policy) | Tenant (policy) | No | No | No by default | No | No |
| Launch / pause / cancel campaign | Tenant | Tenant | No | No | Scoped, approval required | No | No |
| Read campaign recipient details | Tenant | Tenant | No | No | Scoped | No | No |
| Reports | Tenant | Tenant | Scoped | Own workload | Campaign aggregates in scope | Tenant aggregates | Integration health |
| Manage channels / secrets | Tenant | Tenant | No | No | No | No | Delegated integration creds only |
| Invite / change roles / teams | Tenant | Tenant except Owner | No | No | No | No | No |
| Grant service/API scopes | Tenant | Tenant within ceiling | No | No | No | No | Previously delegated only |
| Configure webhooks / CRM mappings | Tenant | Tenant | No | No | No | No | Delegated scope |
| Security audit / retention settings | Tenant | Tenant except destructive ownership | No | No | No | No | Own integration diagnostics |
| Transfer ownership / delete company | Owner + fresh MFA | No | No | No | No | No | No |

**Platform Super Admin** is outside this table. It manages installations, tenant lifecycle, placement, quotas and health through `/platform`. No membership, no chat read, no campaign send by default.

Permission keys (checked by key, never by role name):
`conversation.read`, `conversation.unassigned.preview`, `conversation.reply`, `conversation.note`, `conversation.claim`, `conversation.assign`, `conversation.close`, `contact.read`, `contact.edit`, `contact.merge`, `contact.export`, `consent.read`, `consent.record`, `suppression.write`, `campaign.read`, `campaign.draft`, `campaign.approve`, `campaign.launch`, `campaign.control`, `channel.manage`, `credential.rotate`, `member.manage`, `role.manage`, `integration.manage`, `api_key.manage`, `report.read`, `audit.read`, `retention.manage`, `tenant.delete`.

Revocation target: within **30 seconds**, all session/socket/cached-read access reflects removal. New write/send permits reauthorize against current policy **immediately**. Tenant switch or revoked membership purges affected UI caches and drafts.

## 8. Channel policy rules

- Each channel has its own window, initiation rule, capability set and limits. **Nothing is copied across channels.** A WhatsApp template is not a Messenger template.
- WhatsApp: 24-hour customer-service window; approved templates required outside it; opt-in/opt-out enforced; a clear escalation path when automation is involved.
- Instagram (Instagram Login path): `graph.instagram.com`, Instagram User token, `instagram_business_basic` + `instagram_business_manage_messages`; customer-initiated only; standard 24-hour response window; Advanced Access required to serve accounts the app does not own. Facebook Login is a **separate** configuration with its own fixtures.
- Messenger: Page-scoped recipient IDs, Page access token, `pages_messaging`; its own window and eligible-message rules. Human-agent-style grants never extend bot sending.
- Text limits are validated in **UTF-8 bytes as well as characters** (Arabic, emoji, ZWJ sequences).
- A broadcast may target a channel only if that exact recipient/content/policy combination is supported. Unsupported options are hidden or explained — never queued to fail.
- Channel readiness: `not_configured → authorization_pending → verifying → connected → degraded | reauthorization_required | disconnected`. `connected` requires five separate pieces of evidence: asset authorization, grant verification, subscription verification, inbound test, outbound test. A non-empty token field proves nothing.

## 9. Commercial and entitlement rules

- SaaS entitlements: seat limits, channels, active contacts, storage, campaign quotas, API rates, optional features. Enforced server-side with transactional reservation where needed. The UI shows current usage **and the reason** a limit applied.
- Subscription states may be administered manually at first. Payment checkout, taxation and automated billing are a separate connector decision — never simulated as successful purchases.
- Downgrades never delete existing messages and never weaken isolation.
- Self-hosted: local entitlements only. The inbox must open with **no** call to any SaaS billing or telemetry service.
- Platform message limits (Meta's) and product entitlements (ours) are different things and are displayed separately. Adding workers or phones never "raises" a Meta limit.

## 10. Disaster-recovery business rule

RPO ≤5 min does **not** promise that a restored database contains opt-outs or provider-accepted sends from the lost interval.

Every restore begins with an installation-level `recovery_hold`, enforced **outside** the restored application snapshot, that disables all outbound permits — campaigns, human replies, AI, automations and CRM writes. Restored `active` rows must not auto-restart side effects. Authenticated inbound journaling and read-only diagnosis are allowed where safe.

Before releasing any scope: recover or reconcile suppression, accepted attempts, idempotency records, approvals and usage from intact WAL/replicas/independent journals. Absence of a record in an old snapshot is **not** proof that a message was never sent or that a recipient never opted out. Unresolved cases are quarantined and stay ineligible for outbound until an authorized operator decision. A previous consent snapshot alone cannot clear an uncertain opt-out. Persist a new recovery/dispatch epoch and invalidate old permits before resuming workers. Publish residual loss and uncertainty explicitly.
