# Claude Code master task — finish the CONVO live MVP

You are the senior product engineer, software architect, QA lead, business analyst, and UI designer responsible for finishing this repository. Work in the repository and implement the product. Do not return a plan-only answer, a mockup-only answer, or a cosmetic demo. Continue through the milestones below, running the required checks after each one and recording honest evidence.

## 0. Use the correct repository and protect existing work

1. Run `pwd` first. The only valid repository is `/Users/eyad/Downloads/convo` **without a trailing space**. There is another directory named `/Users/eyad/Downloads/convo `; do not read from or write to it.
2. Run `git status --short` and `git log --oneline -8` before editing.
3. The working tree intentionally contains uncommitted P1-T2, P1-T3, P1-T4, the client demo, and proposal work on top of commit `4d2b851`. Never run `git reset --hard`, `git clean`, discard the dirty tree, or overwrite files without reading them.
4. Preserve all database, API, proposal, and documentation work. Use small checkpoint commits only after the relevant checks pass. Never push secrets.
5. Read these files before deciding or coding:
   - `docs/execution/current-task.md`
   - `docs/requirements/traceability.md`
   - `docs/architecture.md`
   - `docs/api/operation-inventory.md`
   - `docs/api/openapi.v1.json`
   - `docs/product/business-rules.md`
   - `docs/research/provider-evidence.md`
   - `docs/design/design-reference.md`
   - `docs/design/ui-research.md`
   - `docs/testing/strategy.md`
   - `docs/security/threat-model.md`

## 1. Mandatory skills and research

Invoke and follow these Claude Code skills before redesigning the UI: `/design`, `/design-systems`, `/product-polish`, `/wireframing-prototyping`, and `/web-research`. Use the Skill tool; mentioning a skill is not enough.

Use public, official material to inspect current interaction patterns. Study information architecture and behavior; do not copy brand identity, artwork, proprietary assets, or source code.

- Chatwoot inbox layout and queues: <https://www.chatwoot.com/hc/user-guide/en/categories/chatwoot-101>
- Chatwoot filters: <https://www.chatwoot.com/features/conversation-filters>
- Chatwoot conversation API: <https://developers.chatwoot.com/api-reference/conversations/conversations-list>
- respond.io Inbox: <https://respond.io/help/inbox/getting-started-with-inbox>
- respond.io channels: <https://respond.io/help/channels>
- respond.io WhatsApp onboarding: <https://respond.io/help/whatsapp/whatsapp-api-quick-start>
- WhatsApp Cloud API reference: <https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api>
- Messenger Platform reference: <https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api>
- Instagram Messaging API: <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api>

Record any newly used source and the exact adopted interaction pattern in `docs/design/ui-research.md` or `docs/research/provider-evidence.md`. Record blocked pages as blocked. Never present a searched screenshot as a licensed design asset.

## 2. Current product truth — do not misrepresent it

The backend foundation through P1-T4 is real: multi-tenancy, PostgreSQL FORCE RLS, one-time installation bootstrap, NestJS/Fastify boot, local login, durable sessions, CSRF, shared login rate limits, memberships, the first permission boundary, OpenAPI drift checks, idempotency, and signed cursors. The ledger records 299 backend tests and a 100% configured coverage gate at that milestone.

`apps/web` is a client-facing demo. Its channel connection, invitations, team/member edits, campaign launch, exports, and settings contain demo/no-op behavior. It is not wired to real providers or the complete backend. Do not describe it as a live omnichannel product until the real end-to-end gates pass.

The requirements registry currently contains 248 rows: 18 implemented, 7 partial, and 223 planned. This is a full product registry, not a percentage-complete calculation. The immediate goal is the **medium-business live MVP** below. AI/RAG and optional enterprise control-plane work can remain after the live MVP unless a dependency of an MVP flow requires them.

## 3. Milestone A — fix the daily operator UI first

Replace the current layered/append-only CSS approach. `apps/web/src/styles.css` has multiple later token blocks and overrides; do not add another patch block at the end. Refactor it into a coherent token layer, shell/layout layer, components, and screen styles. If you migrate the frontend to React, do it completely and remove the old renderer; never leave two UI architectures mixed together. Keep Vite + strict TypeScript and choose a stable component primitive system only when it materially improves accessibility and testing.

### Visual direction

- Professional, calm support-operations product with light and dark themes.
- The message timeline is the main work area. Use solid, high-contrast surfaces for reading. A restrained glass effect is allowed only on the global rail/top bar, drawers, and overlays; never blur every card or place text over noisy gradients.
- Replace the current `Alexandria` / `IBM Plex Sans Arabic` / `Manrope` mixture. Use one clear Arabic-first family, preferably self-hosted `Readex Pro` with its licence, and a reliable system fallback. Validate Arabic glyphs, English text, punctuation, and digits.
- All numbers, IDs, counts, dates, and times use Western digits `0–9` in Arabic and English. Implement this at the formatter level with `numberingSystem: 'latn'`; do not edit fixture strings manually.
- Light theme: neutral gray ground, white reading surfaces, dark navy text, restrained blue accent, clear borders.
- Dark theme: deep neutral navy surfaces with AA contrast, minimal glow, no washed-out gray body text.
- No oversized headings, decorative marketing heroes, giant KPI cards, excessive rounded cards, or tiny `10px/11px` primary copy.
- Body text is 14–15px, conversation copy 14–16px, UI labels at least 12px, normal Arabic line height around 1.55–1.7. Focus indicators and hover/selected states must be obvious.

### Desktop density and layout acceptance

Validate at `1440×900` and `1366×768`, in Arabic RTL and English LTR, in both themes.

- Entire app shell is exactly `100dvh` and does not create page-level vertical scrolling.
- Global top bar is 48–52px high. Conversation header is at most 64px on one compact row; secondary metadata wraps into a small second row only when required.
- Global navigation rail is 56–60px and can collapse tooltips/labels correctly.
- The saved-view/filter sidebar is closed by default, opens from one clear “Views / القوائم” control, and can be closed with its own button and `Escape`. At widths that would shrink the chat below 640px, it opens as a drawer/overlay.
- Customer details are closed by default and are independently collapsible. Opening them never makes the message area narrower than 640px; use an overlay/drawer or close the competing side panel when needed.
- Conversation list is resizable within about 300–380px. Its rows are 64–72px, use a one-line preview, and show only essential metadata. At least 8 conversation rows are visible at `1366×768` without page zoom.
- The timeline consumes every remaining vertical pixel. The normal seeded conversation displays at least 7 meaningful message/event groups at `1366×768` before scrolling.
- Composer is sticky inside the thread, auto-grows from roughly 44px to a maximum of 88px, and the full composer area is at most 118px in normal reply mode. Remove the large empty footer feeling.
- Add a focus mode that closes both optional side panels and gives the timeline maximum width.
- At tablet/mobile widths, use accessible drawers and a clear back-to-list flow. Do not squeeze four columns onto a small screen.

### Inbox behavior

Implement real client behavior, backed by APIs as soon as the corresponding endpoint exists:

- Queues: All, Unread, Read, Mine, Unassigned.
- Groups: standard queues, inboxes/channels, teams, and saved custom views.
- Filters: unread state, assigned employee multi-select, team, inbox, channel, status, priority, labels, SLA state, date range, search, and sort.
- Active-filter chips, filter count, clear-all, saved view create/update/delete and Private/Team/Workspace visibility.
- Compact row anatomy: contact, single-line preview, channel badge, unread count, assignee, priority/SLA cue, timestamp.
- Assignment, atomic claim, resolve with disposition, pending, snooze, priority, public reply, private note, attachments, emoji, canned responses/macros, and channel-window state.
- Collapsible customer panel: allowlisted identity, labels, consent/suppression, custom attributes, CRM link, activity, attachments, and audit-safe history.
- Loading, empty, offline/stale, error, permission-denied, and expired-channel-window states.
- A user who lacks access to another inbox must not receive its conversations from the API or socket. The unassigned queue uses the restricted projection in `business-rules.md`; hiding fields in the browser is insufficient.
- Default demo tenant content is “Digital School” with course/enrollment/support examples. Remove every Engosoft reference. Production tenant branding/data are dynamic, never hardcoded.

Do not accept “looks better” as verification. Add visual-regression screenshots and DOM assertions for the dimensions and visible-row/message targets above. Run accessibility checks for keyboard, focus order, landmarks, labels, dialogs, contrast, reduced motion, RTL/LTR, and 200% zoom.

## 4. Milestone B — complete identity, roles, people, and teams

Finish P1-T5 before relying on UI-only permission checks:

- Password recovery start/complete with generic responses, single-use HMAC-only tokens, shared limits, transactional password change, and session revocation.
- Invitations: create, expire, revoke, accept once, and prevent hidden tenant/account disclosure.
- Seven tenant roles: Owner, Admin, Supervisor, Agent, Campaign Manager, Analyst, Integration Developer. Platform Super Admin remains outside tenant membership and cannot read chats by default.
- Enforce `Tenant / Scoped(team,inbox) / Own / No` as an intersection of grants, active membership, inbox access, field policy, and delegation ceiling. Authorize by permission key, never display name.
- People, Roles, and Teams APIs and UI; custom role delegation ceiling; last-active-Owner protection; transactional ownership transfer.
- Keep tenant isolation under PostgreSQL FORCE RLS and test pooled connection reuse and privilege-escalation attempts.

## 5. Milestone C — build the real omnichannel conversation path

Create separately scalable API, ingress, realtime, and worker roles. Use durable queues/outbox/inbox patterns defined by the ADRs. A browser request must not call Meta directly.

Implement a channel port and independent adapters/configuration for:

1. WhatsApp Cloud API, including Embedded Signup/manual asset connection, WABA/phone identity, webhook subscription, templates, consent, provider window enforcement, send/status webhooks, and per-asset health.
2. Facebook Messenger Page messaging with its own scopes, Page token, policies, recipient identity, webhooks, and capability matrix.
3. Instagram professional-account messaging with its own login path, scopes, customer-initiated rule, webhooks, identity, and capability matrix.
4. Website live-chat widget with signed installation identity, origin allowlist, conversation continuity, attachments policy, and rate limits.
5. A documented custom-channel adapter contract so another supported channel can be added without branching the domain logic.

For every adapter:

- Verify webhook signatures against the raw request body, reject replay/stale requests, deduplicate provider event IDs, normalize events, and store tenant context from the verified asset mapping.
- Persist inbound events before acknowledging; process asynchronously and idempotently.
- Use an outbox/job state machine for outbound sends. Distinguish accepted, sent, delivered, read, failed, `not_available`, and `outcome_unknown`. Never convert an ambiguous timeout into “failed” or resend it blindly.
- Store secrets encrypted/redacted, rotate credentials, never log tokens, and expose only safe connection health.
- Provide versioned fixtures, a deterministic provider simulator, contract tests, retry/backoff/rate-limit tests, disconnect/reconnect tests, and replay/out-of-order webhook tests.
- Mark the provider-live gate `blocked_no_asset` until authorized real assets exist. A simulator pass is not a provider-live pass.

The Channels screen must execute backend onboarding/test/reconnect/disconnect operations and show evidence-based states: not configured, authorization needed, webhook pending, healthy, degraded, disconnected. Remove all demo `channelAction` messages once the real operations replace them.

## 6. Milestone D — complete inbox, contacts, CRM, and realtime

- Implement list/detail/message APIs with cursor pagination, search, filters, per-user read cursors, unread counts, assignment, claim, participants, labels, notes, attachment metadata, status transitions, dispositions, snooze wake jobs, and audit events.
- Enforce one active conversation per tenant/inbox/contact identity using a database constraint or serialized transaction.
- Implement realtime authorization and projected socket payloads. Revoking membership/inbox access disconnects or narrows the subscription immediately.
- Implement contacts, multiple channel identities, nullable phone, merge with audit trail, consent proof, suppression, imports with validation, and field-level visibility.
- Implement the Odoo CRM adapter behind a version-detected port. When no authorized Odoo instance is supplied, finish deterministic contract/simulator tests and keep the live gate blocked.

## 7. Milestone E — broadcasts and campaign reporting

Implement the campaign system as a real state machine, not cards with a Launch no-op:

- Draft, version, audience builder, saved segment, channel-specific approved template revision, schedule/timezone, quiet hours, estimate, dry run, approval, launch, pause, stop, duplicate, and audit trail.
- Eligibility snapshot and dispatch-time recheck for consent, suppression, template status, channel health/window, tenant entitlement, stop version, and budget.
- Immutable execution and recipient ledger with provider request/message IDs, attempts, reasons, timestamps, and separate dispatch/delivery/read/failure/unknown counts.
- Fair, rate-aware workers. Stopping prevents undispatched work; it never claims to recall a request already accepted by a provider.
- Reports for volume, response/resolution time, SLA, workload, channel, team, agent, campaign funnel, failures, and export jobs. Permissions and scope apply server-side.

Provide realistic Digital School examples: enrollment reminders, new-course launch, payment reminder, class schedule update, certificate availability, and re-engagement. Do not invent delivery/read success when provider receipts do not exist.

## 8. Milestone F — testing, security, and Railway release

Replace every placeholder script that currently exits with `not_run` when its product surface exists.

Required gates:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:unit`
- `pnpm test:integration` against real PostgreSQL
- `pnpm test:coverage` without lowering thresholds or broad exclusions
- adapter contract tests against deterministic simulators
- Playwright end-to-end tests for login → role-scoped inbox → receive → claim → reply → delivery update → resolve, and campaign draft → approval → launch → recipient ledger
- accessibility tests in Arabic RTL and English LTR, light and dark
- security tests for RLS, IDOR/BOLA, CSRF, webhook signatures/replay, SSRF, upload type/size, secret redaction, rate limits, escalation, and tenant/socket isolation
- broker redelivery, worker restart, database restart, timeout ambiguity, webhook reordering, and restore/recovery tests
- load/soak tests in staging with recorded thresholds and environment details

For Railway, add explicit services/process commands, health/readiness checks, migration job, required environment schema, PostgreSQL/RabbitMQ/object storage dependencies, log redaction, backups, and rollback instructions. If Railway is already authenticated and linked, deploy only after all available non-provider gates pass. Never invent secrets or mark WhatsApp/Messenger/Instagram/Odoo live without authorized credentials and observed send/webhook evidence.

## 9. Definition of done and reporting

A milestone is complete only when behavior, persistence, authorization, OpenAPI contract, UI, automated tests, and evidence agree. A button that changes local demo state does not count. A mocked provider test does not count as live provider verification. Do not weaken RLS, idempotency, coverage, or security to make a check green.

After every milestone:

1. Update `docs/execution/current-task.md` with implemented behavior, files, exact test counts/results, limitations, and the next task.
2. Update the matching rows in `docs/requirements/traceability.md` using `implemented/partial/planned`, `passed/not_run`, and `n/a/blocked_no_asset/blocked_env/passed` honestly.
3. Update OpenAPI and run the bidirectional route/spec drift check.
4. Show changed files and exact commands/exit codes.
5. Continue to the next unblocked milestone. Do not stop to ask routine implementation questions. Ask only for an external credential/asset when the corresponding live check is reached, and keep completing simulator-backed and independent work while it is unavailable.

Start now with the repository audit, then Milestone A. Do not finish your response until the changed code and required checks for the current milestone pass.
