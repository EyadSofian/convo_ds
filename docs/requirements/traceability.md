# CONVO — Requirement traceability registry

Source of truth: `research/convo-2026-09-07/implementation-v2/MASTER-PROMPT.md` sections 0–22.
Created: 2026-09-07 (P0). Revision: see `git log` for this file.

## How to read this registry

Four **independent** status fields. None is derived from another.

| Field | Allowed values |
|---|---|
| `Impl` | `planned` / `partial` / `implemented` |
| `Test` | `not_run` / `failing` / `passed` / `blocked_env` |
| `Live` | `n/a` / `blocked_no_asset` / `simulated_only` / `provider_live_verified` |
| `Dep` | `n/a` / `not_deployed` / `staging_verified` / `production_verified` |

Rules enforced on this file:

- A test command that was never executed is `not_run`. It is never `passed`.
- A provider simulator passing is `simulated_only`. It is never `provider_live_verified`.
- A missing external credential blocks only the `Live` column. It never lets `Impl` or `Test` be skipped.
- Every row must eventually name its migration/route/component/test path in `Evidence`.
- No row is deleted to make the registry look complete. Descoped rows move to `descoped` with an ADR link.

At P0 close, every row below was `Impl=planned`, `Test=not_run` — that was the honest baseline, not a gap to hide.

**P1-T1 (2026-09-07)** moved the first rows. Verified by `pnpm test:integration` → exit 0, 18 tests passing against a real PostgreSQL 17.4: TEN-01, TEN-02, TEN-03, TEN-04, TEN-05 and (partially) IAM-08, DEP-02. The coverage gate DEP-14 closed that task **`failing`, and was reported as failing**: 14.51% lines / 28.57% functions / 53.33% branches.

**P1-T2 (2026-09-08)** closed it without lowering a threshold or adding a blanket exclusion. `pnpm test:coverage` → **exit 0**, 174 tests across 20 files, **100% lines / 100% statements / 100% functions / 100% branches**, with per-file 100%-branch gates on the critical modules that exist today. The two causes named in P1-T1 were fixed at the source: `cli.ts` was split into a pure `runCli` with 25 unit tests, and `bootstrap.ts`/`migrate.ts` are now driven **in-process** against throwaway databases on the same real cluster instead of only from Vitest's uninstrumented global-setup process. One file is excluded — `bin.ts`, the process entry point — and it is covered behaviourally by spawning it; every exclusion is reported in [../testing/coverage-exclusions.md](../testing/coverage-exclusions.md). Also moved: MODE-01, MODE-02, MODE-03, MODE-04.

Running `migrate` as a real child process for the first time exposed a genuine defect that Vitest's transform had hidden: `import { Client } from 'pg'` throws under plain Node ESM, so the built `convo-db` CLI would not have started. Fixed in `bootstrap.ts` and `migrate.ts`.

**P1-T3 (2026-09-08)** delivered the first real HTTP boundary. `apps/api` now boots through validated role/mode/database/secret configuration; serves the sanitized `GET /api/v1/instance`; and implements authenticated, Argon2id-hashed, transactional and idempotent `POST /api/v1/instance/bootstrap`. The pinned OpenAPI 3.1 document is diffed against registered Fastify routes in both directions. `pnpm test:coverage` → **exit 0**, 260 tests across 34 files, **100% lines / statements / functions / branches**. A forced failure while persisting the idempotency result proves the company, Owner, bootstrap flag and key roll back together. FORCE RLS also proves an ordinary tenant context cannot read pre-auth installation idempotency rows. Two process entry points are excluded from in-process instrumentation and both are executed as built child processes; see [../testing/coverage-exclusions.md](../testing/coverage-exclusions.md).

**P1-T4 (2026-09-08)** delivered local login, opaque HMAC-only durable session/CSRF verifiers, hardened cookies, PostgreSQL-shared account/IP abuse limits, current-session and owner-scoped session inventory/revocation, active-membership discovery through tenant RLS, and the first `role.manage` permission-key boundary. The pinned OpenAPI document matches all ten registered routes. The full six-command gate passes: 217 unit plus 82 PostgreSQL integration tests; `pnpm test:coverage` → **exit 0**, 299 tests across 40 files, **100% lines / statements / functions / branches**. Recovery storage exists but IAM-03 behavior remains open for P1-T5.

**P1-T6 / Milestone A (2026-09-09)** rebuilt the operator UI's presentation layer and made its density a *tested* contract instead of a claim.

`apps/web/src/styles.css` went from a 3,668-line append-only monolith with **three** competing `:root` token blocks, an `!important` tail and three font families (Alexandria / IBM Plex Sans Arabic / Manrope) to a 29-line entry point that declares one cascade order and loads five layers — `tokens`, `base`, `shell`, `components`, `screens`. The renderer was **not** migrated to React: the existing strict-TypeScript renderer was kept and extended, so there is exactly one UI architecture in the tree, which is what the task requires either way.

Colour is now single-source. `apps/web/src/theme.ts` holds both palettes as data; `apps/web/src/theme.test.ts` parses `styles/tokens.css` and fails if the two disagree, then re-checks **37 WCAG pairs on both themes** — 0 failures. It also proves the checker can fail, forbids a hard-coded colour outside the token layer, and forbids physical `left`/`right` in layout CSS. A dark theme exists for the first time; `design-reference.md` §4.1 previously had none.

Typography is one self-hosted Arabic-first family, Readex Pro (SIL OFL 1.1, licence shipped beside the files at `apps/web/public/fonts/Readex-Pro-OFL.txt`). No third-party font host is contacted, so a self-hosted install opens with no outbound call. Western digits are enforced at the formatter — `numberFormat` / `dateFormat` in `src/format.ts` pass `numberingSystem: 'latn'` explicitly rather than relying on a `-u-nu-latn` locale extension that silently drops — and no fixture string was edited to achieve it.

Density is verified in a real browser, because happy-dom computes no geometry and therefore cannot prove a row is 68px. `tests/e2e/layout.spec.ts` — **64 assertions at 1440×900 and 1366×768**, in Arabic RTL and English LTR, light and dark — asserts 100dvh with no page scrolling, rail 56–60px, top bar 48–52px, conversation header ≤64px, rows 64–72px with a genuinely single-line preview, ≥8 visible rows, ≥7 visible message groups, composer ≤118px at rest growing to 88px, the 640px timeline floor under every side-zone combination, focus mode, tablet/phone drawers and 200% zoom.

Three defects were found by measurement and fixed rather than argued away: the composer was 133px (its area was laid out as a row, so the toolbar sat beside the textarea), the queue showed 7 rows not 8 (a 150px wrapping filter bar plus a redundant 28px meta strip), and the timeline showed 6 groups not 7. Three more were found by looking at the screenshots: an Arabic message rendered with an LTR base direction inside the English UI (fixed with `unicode-bidi: plaintext` on customer content), queue-row cues sheared mid-word (row anatomy capped to assignee + two cues + a count, labels moved to the customer panel), and the thread header crowded the contact name out.

axe-core found four more real accessibility defects, all fixed in the DOM rather than in the assertion: `role="list"` without `listitem` children, two scrollable regions with no keyboard access, an unstyled `.filterbtn` falling back to user-agent chrome that failed AA in dark, and an analytics bar chart whose numeric label was painted on the accent fill (a class mismapping — `.bars__value` is the label, `.bars__fill` is the bar).

`pnpm test:e2e` → **exit 0, 146 tests**; `pnpm test:a11y` → **exit 0, 22 tests**; 40 visual baselines committed under `tests/e2e/visual.spec.ts-snapshots/`. Three placeholder scripts that previously exited 1 with `not_run` are now real runs: `test:e2e`, `test:a11y` and the new `test:visual`. `test:contracts`, `test:security`, `test:mutation`, `test:load:target` and `test:recovery` still exit 1 honestly, because their product surfaces do not exist yet.

The coverage gate held at **100% lines / statements / functions** and 98.97% branches (threshold 95) across **662 tests in 57 files**, with no threshold lowered and no new exclusion. `apps/web/src/theme.ts` reached 100% only after `contrastFailures` was made palette-injectable so its failure path could actually be executed by a test.

**Milestone A does not make `apps/web` a live product.** UX-09 stays `planned`: channel connection, invitations, team/member edits, campaign launch and exports remain demo/no-op behaviour with no backend call. Nothing in this milestone touched the API surface, so `docs/api/openapi.v1.json` is unchanged and the bidirectional route/spec drift test in `tests/integration/api-contract.test.ts` passed unchanged.

**P1-T5 / Milestone B, first slice (2026-09-09)** delivered the role boundary: the matrix, the engine, and the administration read surface.

`packages/domain/src/iam/` is new and framework-independent. `permissions.ts` mirrors the 29-key catalogue and the non-delegable set, with tests that parse `0003_permission_catalogue.sql` so the module and the database cannot disagree. `roles.ts` holds the seven built-in roles as data, transcribed cell by cell from `business-rules.md` §7 — and `roles.test.ts` asserts every cell *and* parses `0007_role_matrix.sql`, so the matrix exists in exactly one place with two mechanical checks around it. Platform Super Admin is deliberately not among them: it sits outside tenant membership, and modelling it as an eighth role would put it inside the boundary the rules forbid.

`authorize.ts` implements invariant I3 as five sequential narrowing terms — active membership ∩ tenant status ∩ action grant ∩ delegation ceiling ∩ resource scope. There is no branch that widens a decision, which is what makes default-deny structural rather than aspirational, and a `Principal` carries grants rather than a role label, so there is nowhere to write `if (role === 'admin')`. 41 tests cover each term in isolation, `own` reached by assignment and by past participation, lost inbox access overriding assignment, an empty ceiling meaning "nothing" rather than "no ceiling", and a full 7-role × 29-key sweep.

One design defect was found by a test and fixed rather than accommodated: the denial reason was originally derived from the grant *level*, so an agent who had lost inbox access was reported as `not_own_resource`. The reason now names the term that actually failed, because the operator's next step and the audit line differ between "ask for the inbox back" and "this is not your conversation".

Migration `0007_role_matrix.sql` adds `scope_level` to `role_permissions` — until now a grant carried no scope and every grant behaved as tenant-wide — seeds all seven roles per tenant, and adds `memberships_keep_an_owner`, a **DEFERRABLE INITIALLY DEFERRED** constraint trigger. Last-Owner protection lives in the database because two concurrent transactions each removing "the other" Owner would both pass an application-level check; deferring it to commit is what lets a legitimate transactional transfer be Owner-less mid-flight and still commit with exactly one Owner. `none` is deliberately absent from the `scope_level` CHECK: a denial is the absence of a row, and two representations of denial is how a permission check ends up reading the wrong one.

`apps/api/src/authorization/authorization.service.ts` is now the single HTTP entry point to the engine. It loads the principal **inside the same RLS transaction the work runs in**, so a membership revoked between check and write cannot be used. Before this, `PermissionService` inlined `SELECT ... WHERE permission_key = 'role.manage'` — correct for one route, and the beginning of a per-endpoint copy of the rules. Non-membership, revoked membership and an inactive tenant all conceal as 404; 403 is reserved for "you are a member here and this action is denied", because answering 403 to a stranger confirms the company exists.

Three routes were added and documented: `GET /tenants/{id}/roles`, `/people`, `/teams`. The bidirectional route/spec drift test passes with the pinned OpenAPI updated, and the contract now pins that `scope_level` admits only `tenant|scoped|own` so a client cannot render a "none" chip.

`tests/integration/api-authorization.test.ts` (16 tests, real PostgreSQL) proves the database half: all seven roles seeded with the scope levels the domain declares, every built-in role gated correctly across the administration surface, revoked membership concealed as 404, unknown and malformed tenants refused identically, the last-Owner trigger rejecting both revoke and demote, a transactional transfer succeeding, and — with a deliberately small pool — that a reused connection never carries one tenant's context into another transaction and that no context at all means zero rows.

Gates: `pnpm lint` / `typecheck` / `build` exit 0; `test:unit` 46 files / **664 tests**; `test:integration` 14 files / **98 tests**; `test:coverage` 60 files / **762 tests** at **100% lines / statements / functions**, 99.02% branches; `test:e2e` 146 and `test:a11y` 22 still exit 0. No threshold lowered, no exclusion added.

**Not delivered in this slice, and not claimed:** password recovery start/complete HTTP behaviour (the hardened schema exists, IAM-03 stays `planned`), invitations (IAM-06 stays `planned`), custom-role creation with a delegation ceiling write path, ownership-transfer acceptance/decline/expiry, MFA, and the People/Roles/Teams **UI** — `apps/web` remains a demo and is not wired to these endpoints.

## Family index

| Family | Meaning | Master sections |
|---|---|---|
| MODE | Deployment modes, installation, bootstrap, provisioning | 16 |
| TEN | Tenancy, isolation, RLS, placement | 3, 16 |
| IAM | Identity, sessions, MFA, roles, scopes, service principals | 3, 17 |
| CH-WA | WhatsApp Cloud API channel | 5, 20 |
| CH-MSG | Facebook Messenger channel | 5, 20 |
| CH-IG | Instagram channel | 5, 20 |
| CON | Conversation lifecycle, assignment, ownership | 4, 18.1 |
| CT | Contacts, identities, consent, suppression, segments | 3, 4 |
| COL | Collaboration: notes, mentions, canned replies, macros, presence | 4 |
| MSG | Messaging, composer, drafts, read cursor, timeline | 4, 6 |
| MEDIA | Attachments, quarantine, scanning, retention | 6 |
| TPL | Template management | 5 |
| CMP | Campaigns and broadcast engine | 7, 18.2 |
| DEL | Durable ingestion, outbox, dispatch, receipts, realtime | 6 |
| API | Public REST API, outgoing webhooks, SDK | 8, 19 |
| CRM | Odoo and general integration framework | 9 |
| AUTO | Automation rules | 10 |
| SLA | Business hours, routing, SLA clocks, CSAT | 10 |
| REP | Reporting, analytics, usage | 10 |
| AI | Copilot, RAG, tools, handoff | 11 |
| UX | Design system, i18n/RTL, accessibility, screen contracts | 1, 20.2 |
| SEC | Security controls and the SEC/EVT/TX behavioural matrix | 13 |
| DEP | Build, release, HA/DR, observability, runbooks | 12, 16 |

---

## MODE — deployment modes

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| MODE-01 | `DEPLOYMENT_MODE` is trusted installation config, read only from validated env at boot | P1 | Request body/query/Host cannot change mode; startup fails on invalid value | implemented | passed | n/a | n/a | `packages/domain/src/installation/config.ts`; `apps/api/src/config.ts`; source scan covers packages and apps and permits `process.env` only in the two process entry modules |
| MODE-02 | `GET /instance` returns sanitized capabilities only | P1 | No secrets, no tenant list, safe pre-auth | implemented | passed | n/a | n/a | `GET /api/v1/instance` in `apps/api`; descriptor keys are allowlisted and HTTP integration asserts no database credential or tenant list is exposed |
| MODE-03 | One-time self-hosted bootstrap creates exactly one company + Owner | P1 | Second bootstrap call is a harmless typed rejection; bootstrap disables itself | implemented | passed | n/a | n/a | Domain transaction plus `POST /api/v1/instance/bootstrap`; a minimum-32-byte installer token authenticates the pre-auth route, Argon2id hashing occurs before the domain boundary, and typed 400/401/409/503 mappings and replay are verified on PostgreSQL |
| MODE-04 | `self_hosted_single` rejects creation of a second company by any path | P1 | Platform provisioning API returns typed error in this mode | partial | passed | n/a | n/a | Migration `0004` enforces the invariant for runtime and schema-owner paths. The future platform provisioning route is still absent, so its typed response remains to be implemented |
| MODE-05 | SaaS provisioning API + platform control plane, idempotent and audited | P1 | Repeat provisioning returns same tenant, no duplicate | planned | not_run | n/a | n/a | |
| MODE-06 | Tenant lifecycle `provisioning→active→suspended→deletion_pending→deleted` | P1 | Each transition audited; failed provisioning visible and retryable | planned | not_run | n/a | n/a | |
| MODE-07 | Suspension blocks new outbound/API mutations, revokes interactive access | P4 | Authenticated inbound goes to bounded quarantine, not silent drop | planned | not_run | n/a | n/a | |
| MODE-08 | Quarantine capacity exhaustion returns retryable failure + alert, never fake ACK | P4 | Ingress returns 5xx retryable when quarantine is full | planned | not_run | n/a | n/a | |
| MODE-09 | Reactivation replays retained events with dedupe; paused campaigns need explicit resume | P4 | No auto-resume of campaigns | planned | not_run | n/a | n/a | |
| MODE-10 | Tenant deletion is retention-aware; ID never reused; assets not silently reassigned | P8 | Deletion job with retention policy and audit | planned | not_run | n/a | n/a | |
| MODE-11 | SaaS entitlements: seats, channels, active contacts, storage, campaign quota, API rate | P8 | Server-side enforcement with transactional reservation; UI shows limit reason | planned | not_run | n/a | n/a | |
| MODE-12 | Self-hosted core inbox never calls a SaaS billing/telemetry service | P8 | Network-isolated install still logs in and messages | planned | not_run | n/a | n/a | |
| MODE-13 | Hardened single-host production Compose profile, distinct from dev Compose | P8 | TLS, non-root, volumes, closed DB/broker ports, resource limits, healthchecks | planned | not_run | n/a | not_deployed | |
| MODE-14 | Helm/K8s HA profile for SaaS and self-hosted HA from the same images | P8 | Same immutable revision deployed both ways | planned | not_run | n/a | not_deployed | |
| MODE-15 | Installer validates config + callback reachability, migrates once, no default password | P8 | Idempotent install; missing production secret fails startup | planned | not_run | n/a | not_deployed | |
| MODE-16 | Tenant export/import between SaaS and self-hosted preserving IDs/consent/receipts/idempotency | P8 | Quiesce, transfer, re-encrypt, reauthorize, one active dispatcher | planned | not_run | n/a | n/a | |
| MODE-17 | Separate release evidence report per deployment mode | P8 | Two reports off one revision | planned | not_run | n/a | not_deployed | |

## TEN — tenancy and isolation

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| TEN-01 | Every tenant-owned table has non-null `tenant_id` | P1 | Migration lint fails on a tenant table without it | implemented | passed | n/a | n/a | packages/database/migrations/0001_foundation.sql |
| TEN-02 | Composite FKs `(tenant_id, x_id) → (tenant_id, id)` on all cross-entity links | P1 | DB rejects a cross-tenant relationship insert | implemented | passed | n/a | n/a | tests/integration/tenant-isolation.test.ts |
| TEN-03 | RLS enabled with both USING and WITH CHECK; FORCE RLS where owner writes | P1 | Direct SQL as runtime role cannot read/write other tenant | implemented | passed | n/a | n/a | `0002_rls.sql` covers the foundation tables; `0005_idempotency.sql` adds FORCE RLS for tenant command ledgers and a separate pre-auth installation context. Real-DB tests prove a tenant context cannot see installation idempotency rows |
| TEN-04 | Runtime DB role is not owner/superuser/BYPASSRLS; migration role separate | P1 | `pg_roles` assertion test | implemented | passed | n/a | n/a | packages/database/src/bootstrap.ts; tests/integration/runtime-role.test.ts |
| TEN-05 | Transaction-local tenant context is set and verified, pooling-safe | P1 | Pool reuse test: context does not leak between transactions | implemented | passed | n/a | n/a | `packages/database/src/context.ts`; `tests/integration/tenant-isolation.test.ts` (real pooled reuse) plus `packages/database/src/context.test.ts` for the failure paths a working database will not produce on demand: read-back disagreement aborts before the caller's work runs, a rollback that itself throws still reports the original error, and the connection is released on every path |
| TEN-06 | Tenant scoping in cache keys | P1 | Key prefix assertion + cross-tenant cache read test | planned | not_run | n/a | n/a | |
| TEN-07 | Tenant scoping in WebSocket subscriptions; no global wildcard broadcast | P2 | Subscribe to other tenant topic denied | planned | not_run | n/a | n/a | |
| TEN-08 | Tenant scoping in object storage paths + signed access | P2 | Signed URL for other tenant's object denied | planned | not_run | n/a | n/a | |
| TEN-09 | Tenant scoping in search index/results/snippets | P3 | Search fixture with two tenants; no leak in snippets | planned | not_run | n/a | n/a | |
| TEN-10 | Tenant scoping in exports, logs, metric detail endpoints, backups | P6 | Export job ownership check; no unbounded metric labels | planned | not_run | n/a | n/a | |
| TEN-11 | Tenant scoping in AI retrieval and tool calls | P7 | Cross-tenant retrieval returns nothing | planned | not_run | n/a | n/a | |
| TEN-12 | Tenant placement abstraction allowing dedicated cells for large/regulated tenants | P8 | Placement recorded in control plane; routing honors it | planned | not_run | n/a | n/a | |

## IAM — identity, roles, scopes

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| IAM-01 | Global human identity separate from membership | P1 | One identity, memberships in N tenants (SaaS) | implemented | passed | n/a | n/a | Global `users`; tenant-scoped `memberships`; minimal trigger-maintained discovery index; `GET /me/memberships` resolves each company under FORCE RLS. `tests/integration/api-auth.test.ts` covers active and suspended membership behavior |
| IAM-02 | Local auth: audited password hashing, secure HttpOnly cookies, CSRF, rate limits | P1 | No token in localStorage; CSRF test; lockout test | implemented | passed | n/a | n/a | Argon2id passwords; opaque HMAC-only durable session/CSRF verifiers; Secure HttpOnly SameSite=Strict session cookie; double-submit server validation; PostgreSQL rate buckets and Retry-After. `tests/integration/api-auth.test.ts` |
| IAM-03 | Recovery does not disclose account existence; tokens single-use, never logged | P1 | Same response for known/unknown email; log scan test | planned | not_run | n/a | n/a | |
| IAM-04 | MFA enrol/verify/recovery-codes; fresh-MFA gate for ownership actions | P1 | Owner transfer requires fresh MFA | planned | not_run | n/a | n/a | |
| IAM-05 | Session inventory and revocation (`GET/DELETE /auth/sessions/{id}`) | P1 | Revoked session's next request fails | implemented | passed | n/a | n/a | Owner-scoped inventory/detail/revoke; self-revoke clears cookies; revocation wins on the next request and survives API restart. `tests/integration/api-auth.test.ts` |
| IAM-06 | Invitations: create, expire, single-use accept, revoke | P1 | Expired/reused token rejected | planned | not_run | n/a | n/a | |
| IAM-07 | Tenant switching lists only active memberships | P1 | Suspended membership hidden and denied | implemented | passed | n/a | n/a | `GET /me/memberships`; suspended membership is hidden after trigger-index discovery and tenant-RLS resolution. `tests/integration/api-auth.test.ts` |
| IAM-08 | Permission keys (not role-name checks) — the 28 keys in master §17 | P1 | Registry test asserts every key exists and is used | implemented | passed | n/a | n/a | Immutable catalogue and Owner grants by key; `GET /tenants/{tenantId}/permissions` checks `role.manage` by key under tenant RLS; owner allow, agent deny and nonmember concealment covered by `tests/integration/api-auth.test.ts` |
| IAM-09 | Seven built-in roles matching the master §17 matrix exactly | P1 | Table-driven allow/deny test per role per key per scope | implemented | passed | n/a | n/a | `packages/domain/src/iam/roles.ts` (matrix as data), `packages/database/migrations/0007_role_matrix.sql` (seeded per tenant), `packages/domain/src/installation/bootstrap.ts` (all seven at creation). `roles.test.ts` asserts the matrix cell by cell against business-rules.md §7 **and** parses migration 0007 so the two cannot drift; `tests/integration/api-authorization.test.ts` re-checks every reported grant against the domain matrix over HTTP. Platform Super Admin is deliberately absent — it is outside tenant membership. |
| IAM-10 | Scope model: Tenant / Scoped(team,inbox) / Own / No; effective access = intersection | P1 | Intersection unit + property tests | implemented | passed | n/a | n/a | `packages/domain/src/iam/authorize.ts` implements I3 as five narrowing terms (active membership ∩ tenant ∩ grant ∩ delegation ceiling ∩ resource scope); no branch widens a decision. `authorize.test.ts` (41 tests) covers each term, `own` via assignment and participation, lost inbox access overriding assignment, and a 7-role × 29-key sweep. `apps/api/src/authorization/authorization.service.ts` is the only HTTP entry point to it. |
| IAM-11 | `conversation.unassigned.preview` returns projected queue card only | P2 | Response schema has no snippet/timeline/notes/media/contact PII | planned | not_run | n/a | n/a | |
| IAM-12 | Full timeline requires successful claim/participation | P2 | Pre-claim direct GET denied; post-claim allowed; post-revoke denied | planned | not_run | n/a | n/a | |
| IAM-13 | Atomic claim: exactly one winner at same version, other gets typed conflict | P2 | Concurrency test with two writers | planned | not_run | n/a | n/a | |
| IAM-14 | Custom roles grant only delegable permissions the actor holds | P1 | Escalation attempt rejected | partial | passed | n/a | n/a | The **ceiling is enforced**: `authorize` refuses a non-delegable key to any credential principal even when the ceiling lists it, and refuses a delegable key absent from the ceiling (`authorize.test.ts`, term 4). Custom-role *creation* is not implemented yet, so there is no write path to test; `delegationCeiling` is `null` for session principals until API keys exist (P5). |
| IAM-15 | Last active Owner cannot be deleted, suspended or demoted | P1 | Typed rejection | implemented | passed | n/a | n/a | Enforced in PostgreSQL by `memberships_keep_an_owner`, a DEFERRABLE INITIALLY DEFERRED constraint trigger in migration 0007 — not only in a service, because two concurrent transactions each removing "the other" Owner would both pass an application check. `tests/integration/api-authorization.test.ts` proves revoke and demote of the sole Owner both fail and roll back whole. |
| IAM-16 | Ownership transfer is transactional with recipient acceptance + recovery path | P1 | Accept/expire/decline paths | partial | passed | n/a | n/a | The **transactional half is proven**: the deferred trigger permits a demote-then-promote transfer that is Owner-less mid-transaction and commits with exactly one Owner (`tests/integration/api-authorization.test.ts`). Recipient acceptance, decline, expiry and the fresh-MFA gate (IAM-04) are not implemented. |
| IAM-17 | Platform Super Admin has no tenant membership or chat read by default | P1 | `/platform` grants cannot read a conversation | partial | passed | n/a | n/a | The tenant role set is closed at seven and asserted to exclude any super-admin key (`roles.test.ts`), so no tenant role can be a platform role. The `/platform` surface itself does not exist yet. |
| IAM-18 | Support access grant: scoped, reasoned, expiring (default max 60 min), MFA, banner, audit | P8 | Expiry test; banner rendered; audit row | planned | not_run | n/a | n/a | |
| IAM-19 | Service principals: tenant-scoped, explicit scopes, delegation ceiling | P5 | Developer cannot mint a key stronger than own grants | planned | not_run | n/a | n/a | |
| IAM-20 | API key: verifier stored, secret shown once, rotation overlap, revocation wins | P5 | Second read of secret impossible; revoked key fails immediately | planned | not_run | n/a | n/a | |
| IAM-21 | Revocation propagates to sessions/sockets/cached decisions within 30s | P2 | Timed test with open socket | planned | not_run | n/a | n/a | |
| IAM-22 | Enterprise SSO via OIDC with state/nonce/PKCE validation | P8 | Replayed state rejected | planned | not_run | blocked_no_asset | n/a | |
| IAM-23 | Masked PII fields are masked server-side in list/detail/search/export/socket/API | P3 | Raw response assertion, not CSS | planned | not_run | n/a | n/a | |
| IAM-24 | Safe assignee directory endpoint: allowlisted presentation fields only | P2 | No admin-only member metadata in response | planned | not_run | n/a | n/a | |

## CH-WA / CH-MSG / CH-IG — channels

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| CH-00 | Typed provider-neutral adapter contract (10 methods of master §5) | P2 | Contract test suite runs against every adapter | planned | not_run | n/a | n/a | |
| CH-01 | Versioned capability matrix per channel; unsupported inbound stored + fallback UI | P2 | Capability snapshot test per Graph version | planned | not_run | n/a | n/a | |
| CH-02 | Channel readiness states: not_configured…disconnected, with separate evidence per check | P2 | Connected badge requires asset+grant+subscription+inbound+outbound evidence | planned | not_run | n/a | n/a | |
| CH-03 | One active provider asset ↔ one authoritative connection, installation-wide uniqueness registry | P2 | Second tenant claiming same asset denied without revealing the other tenant | planned | not_run | n/a | n/a | |
| CH-WA-01 | WhatsApp Cloud API adapter: send text/media/template | P2 | Fixture contract tests per message type | planned | not_run | blocked_no_asset | n/a | |
| CH-WA-02 | Webhook signature verified against exact raw bytes, constant-time | P2 | Altered-byte test rejects | planned | not_run | n/a | n/a | |
| CH-WA-03 | Embedded Signup / Connect with Meta onboarding + manual admin setup path | P2 | Both flows persist app/portfolio/WABA/phone identifiers and secret refs | planned | not_run | blocked_no_asset | n/a | |
| CH-WA-04 | Distinguish App ID / App Secret / access token / webhook verify token | P2 | Schema + UI labels; verify token never accepted as POST auth | planned | not_run | n/a | n/a | |
| CH-WA-05 | 24-hour customer-service window enforcement with template requirement outside it | P2 | Window closed → typed `WINDOW_EXPIRED`, draft preserved | planned | not_run | n/a | n/a | |
| CH-WA-06 | Configurable provider limits with observed value, provenance, effective date | P4 | Phone throughput vs portfolio unique-recipient vs template pacing modelled separately | planned | not_run | blocked_no_asset | n/a | |
| CH-WA-07 | Direct Send and coexistence/history-sync stay feature-flagged off until verified | P3 | Flags default false; enabling requires recorded evidence | planned | not_run | blocked_no_asset | n/a | |
| CH-MSG-01 | Messenger adapter: Page-scoped IDs, page token, `pages_messaging` | P3 | Separate fixtures; no WhatsApp rule reuse | planned | not_run | blocked_no_asset | n/a | |
| CH-MSG-02 | Messenger window/eligible-message rules enforced independently | P3 | Policy unit tests per channel | planned | not_run | n/a | n/a | |
| CH-MSG-03 | HUMAN_AGENT-style grants never extend bot sending privileges | P3 | Bot permit denied under human-agent-only eligibility | planned | not_run | n/a | n/a | |
| CH-IG-01 | Instagram Login path: `graph.instagram.com`, IG User token, `instagram_business_basic` + `instagram_business_manage_messages` | P3 | Host/token/scope set distinct from Facebook Login config | planned | not_run | blocked_no_asset | n/a | |
| CH-IG-02 | Facebook Login path for Instagram is a separately verified adapter configuration | P3 | Two configs, two fixture sets | planned | not_run | blocked_no_asset | n/a | |
| CH-IG-03 | Customer-initiated only + 24h standard response window | P3 | Cold DM attempt rejected with typed reason | planned | not_run | n/a | n/a | |
| CH-IG-04 | Text limits measured in UTF-8 bytes as well as characters (Arabic) | P3 | Boundary tests with Arabic + emoji + ZWJ | planned | not_run | n/a | n/a | |
| CH-04 | Echoes, identity rotation, reactions, shared media handled per actual support | P3 | Fixture per event; unsupported quarantined | planned | not_run | n/a | n/a | |
| CH-05 | Degrade safely on expired/revoked credentials; other tenants/channels unaffected | P2 | Blast-radius test | planned | not_run | n/a | n/a | |
| CH-06 | Provider privacy callbacks: deauthorize, data-deletion, confirmation lookup | P3 | Verified under the provider's own signed-callback contract | planned | not_run | blocked_no_asset | n/a | |

## TPL — templates

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| TPL-01 | Template sync from provider with status, language, category, components | P3 | Sync job + last-sync freshness in UI | planned | not_run | blocked_no_asset | n/a | |
| TPL-02 | Local template revisions; create/edit/submit where supported | P3 | Revision history; submit state machine | planned | not_run | blocked_no_asset | n/a | |
| TPL-03 | Variable validation + media/button capability validation before save | P3 | Invalid parameter shape rejected with field errors | planned | not_run | n/a | n/a | |
| TPL-04 | Template eligibility revalidated at dispatch, not only at draft | P4 | Paused-after-approval test blocks new permits | planned | not_run | n/a | n/a | |
| TPL-05 | WhatsApp templates are not reused as Messenger/Instagram templates | P3 | Cross-channel reuse rejected | planned | not_run | n/a | n/a | |

## CON / MSG / COL / MEDIA — inbox core

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| CON-01 | At most one non-archived active conversation per `(tenant, inbox, contact_identity)` | P2 | DB constraint or serialized transaction; race test | planned | not_run | n/a | n/a | |
| CON-02 | Full lifecycle table of master §18.1 implemented as explicit transitions | P2 | One test per row of that table | planned | not_run | n/a | n/a | |
| CON-03 | Snooze stores UTC wake time + source timezone; durable versioned wake job | P2 | Restart test; old wake job invalidated | planned | not_run | n/a | n/a | |
| CON-04 | Reopen on new inbound to latest non-archived resolved thread; new reporting episode | P2 | Original episode metrics retained | planned | not_run | n/a | n/a | |
| CON-05 | Receipts/typing/notes never reopen a conversation | P2 | Negative tests | planned | not_run | n/a | n/a | |
| CON-06 | Campaign outbound alone does not change support-thread state | P4 | Reply is what opens/reopens | planned | not_run | n/a | n/a | |
| CON-07 | Ownership dimensions separate: bot/human ownership vs read state vs delivery state | P2 | Model + API assertion | planned | not_run | n/a | n/a | |
| CON-08 | Assignment, priority, labels, custom fields, participants, handoff | P2 | Persisted + audited | planned | not_run | n/a | n/a | |
| MSG-01 | Timeline pagination with stable cursor and no gaps/duplicates after reconnect | P2 | Reconnect + expired-cursor tests | planned | not_run | n/a | n/a | |
| MSG-02 | Composer draft persistence surviving navigation, reconnect and failed send | P2 | Draft never lost on optimistic failure | planned | not_run | n/a | n/a | |
| MSG-03 | Optimistic message reconciles by `client_message_id` → server/provider IDs | P2 | Retry of same UI action creates one command | planned | not_run | n/a | n/a | |
| MSG-04 | Per-user unread read-cursor; reconcilable derived counts | P2 | Two agents have independent unread | planned | not_run | n/a | n/a | |
| MSG-05 | Explicit pending/failed/unknown send feedback with reason codes | P2 | Each delivery state has a UI state | planned | not_run | n/a | n/a | |
| MSG-06 | Virtualized conversation list and timeline with stable scroll/selection/keyboard | P2 | 10k-row fixture; a11y keyboard test | planned | not_run | n/a | n/a | |
| COL-01 | Private notes never leave through a customer channel | P2 | Adapter-level assertion + e2e | planned | not_run | n/a | n/a | |
| COL-02 | Mentions, canned replies, macros with reauthorized per-action execution | P3 | Macro execution trace | planned | not_run | n/a | n/a | |
| COL-03 | Presence/typing/collision warning is ephemeral and never decides durable ownership | P3 | Presence loss does not change assignment | planned | not_run | n/a | n/a | |
| MEDIA-01 | Media download in separate workers with allowlisted endpoints and safe DNS/redirect rules | P2 | SSRF test suite | planned | not_run | n/a | n/a | |
| MEDIA-02 | MIME sniffing, size/time limits, quarantine before availability | P2 | Extension/MIME spoof test | planned | not_run | n/a | n/a | |
| MEDIA-03 | Short-lived tenant-scoped signed access URLs | P2 | Cross-tenant and expired URL denied | planned | not_run | n/a | n/a | |
| MEDIA-04 | Note attachment cannot become a public message attachment without explicit re-share | P2 | Reference attempt rejected | planned | not_run | n/a | n/a | |
| MEDIA-05 | Documented media retention and actual deletion | P8 | Retention job evidence | planned | not_run | n/a | n/a | |

## CT — contacts, identity, consent

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| CT-01 | Contact has stable internal ID; phone nullable | P2 | Phone-absent contact fully usable | planned | not_run | n/a | n/a | |
| CT-02 | Scoped external identity: provider, scope type/id, external id, validity interval, provenance | P2 | Identity rotation creates a new interval, not an overwrite | planned | not_run | n/a | n/a | |
| CT-03 | No identity inference from display name/username/similar phone | P3 | Fuzzy auto-merge absent by design | planned | not_run | n/a | n/a | |
| CT-04 | Merge is a reviewable, audited, reversible-link operation | P3 | Merge preview → commit → reverse | planned | not_run | n/a | n/a | |
| CT-05 | Original text/identity preserved beside normalized search representation | P3 | Arabic original byte-identical after normalization indexing | planned | not_run | n/a | n/a | |
| CT-06 | Consent evidence: source, proof ref, purpose/channel scope, timestamp, actor | P3 | Immutable evidence rows | planned | not_run | n/a | n/a | |
| CT-07 | CSV import never implies opt-in | P3 | Imported contact is not campaign-eligible without explicit consent | planned | not_run | n/a | n/a | |
| CT-08 | Suppression wins over stale consent and over CRM imports | P3 | Stale CRM write cannot clear suppression | planned | not_run | n/a | n/a | |
| CT-09 | Streaming CSV import with mapping preview and row-level errors | P3 | 1M-row import bounded memory + resumable | planned | not_run | n/a | n/a | |
| CT-10 | Async authorized export jobs with expiring access | P3 | Export of another tenant/job denied | planned | not_run | n/a | n/a | |
| CT-11 | Segments as validated safe AST, not raw SQL | P3 | Injection attempt rejected by parser | planned | not_run | n/a | n/a | |
| CT-12 | Opt-out keyword policy documented and configurable incl. Arabic equivalents | P4 | Ambiguous match never grants consent | planned | not_run | n/a | n/a | |
| CT-13 | Removing suppression requires a new explicit opt-in workflow + audit | P4 | Direct unsuppress denied | planned | not_run | n/a | n/a | |

## DEL — durable ingestion, dispatch, realtime

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| DEL-01 | Ingress: TLS, body size/content limits, provider auth before any processing | P2 | Oversized/unsigned rejected | planned | not_run | n/a | n/a | |
| DEL-02 | Connection/tenant resolved from verified channel assets; caller tenant ID never authoritative | P2 | Forged tenant header ignored | planned | not_run | n/a | n/a | |
| DEL-03 | Raw event/batch journal persisted durably **before** ACK; failed persistence ≠ 200 | P2 | Kill-before-commit test returns non-2xx | planned | not_run | n/a | n/a | |
| DEL-04 | No CRM/AI/media work inside webhook ACK path | P2 | ACK latency budget test p95 ≤200ms | planned | not_run | n/a | n/a | |
| DEL-05 | Normalization with schema version + provider/type-specific dedupe | P2 | Duplicate across reordered batches → one effect | planned | not_run | n/a | n/a | |
| DEL-06 | Poison/unknown event quarantined without dropping the batch | P2 | Mixed batch test | planned | not_run | n/a | n/a | |
| DEL-07 | Domain change + outbox event in one transaction | P2 | Crash between them impossible by construction | planned | not_run | n/a | n/a | |
| DEL-08 | Outbox relay publishes small envelopes, marks only after broker confirm | P2 | Publish-marker loss → duplicate, consumer idempotent | planned | not_run | blocked_env | n/a | |
| DEL-09 | Manual consumer ACK after commit; DLQ + bounded retries + audited replay | P2 | Replay tool test | planned | not_run | blocked_env | n/a | |
| DEL-10 | Outbound command: 202 only after durable transaction, with stable IDs | P2 | No 202 before commit | planned | not_run | n/a | n/a | |
| DEL-11 | Dispatcher rechecks permission/channel/window/consent/template/identity/ownership/budget at permit time | P2 | Each recheck has a failing-path test | planned | not_run | n/a | n/a | |
| DEL-12 | Durable attempt/permit recorded **before** network dispatch | P2 | Crash after dispatch is reconstructible | planned | not_run | n/a | n/a | |
| DEL-13 | Delivery outcome classifier: accepted / definitely_rejected / outcome_unknown | P2 | Classifier unit + property tests | planned | not_run | n/a | n/a | |
| DEL-14 | `outcome_unknown` is never blindly resent | P2 | Lost-response test does not resend | planned | not_run | n/a | n/a | |
| DEL-15 | Command state and provider delivery state stored separately | P2 | 12 documented states; no integer-max transitions | planned | not_run | n/a | n/a | |
| DEL-16 | Late delivery never rolls back read; conflicting failure never erases delivery | P2 | EVT-04 test | planned | not_run | n/a | n/a | |
| DEL-17 | Receipts arriving before the send response are held and reconciled, not lost | P2 | Out-of-order test | planned | not_run | n/a | n/a | |
| DEL-18 | Per-conversation ordering via serialized dispatch gate with fencing + durable versions | P2 | Stale worker cannot publish authoritative state | planned | not_run | n/a | n/a | |
| DEL-19 | Realtime events carry schema_version, event_id, entity+version, scope | P2 | Schema contract test | planned | not_run | n/a | n/a | |
| DEL-20 | Catch-up endpoint with cursors handling gaps/duplicates/expiry/permission change | P2 | `reset_required` path tested | planned | not_run | n/a | n/a | |
| DEL-21 | Capped client send buffers, slow-consumer handling, heartbeat, reconnect jitter | P2 | 2000-socket reconnect storm bounded | planned | not_run | blocked_env | n/a | |
| DEL-22 | Presence traffic has separate limits from durable events | P3 | Presence flood does not starve events | planned | not_run | n/a | n/a | |

## CMP — campaigns

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| CMP-01 | Control states of master §18.2 as explicit machine | P4 | One test per transition incl. invalid ones | planned | not_run | n/a | n/a | |
| CMP-02 | Immutable audience snapshot with provenance + schema version + visible timestamp | P4 | Later-added contact excluded | planned | not_run | n/a | n/a | |
| CMP-03 | Eligibility recorded separately at snapshot and at dispatch | P4 | Both recorded on every recipient row | planned | not_run | n/a | n/a | |
| CMP-04 | Validation produces a reviewable report without sending | P4 | Dry run sends zero provider requests | planned | not_run | n/a | n/a | |
| CMP-05 | Test-send requires explicit authorized test recipient, same validation/adapter path | P4 | Non-test recipient rejected | planned | not_run | blocked_no_asset | n/a | |
| CMP-06 | Approval binds to immutable revision hash; meaningful change invalidates it | P4 | Audience/template/variable/schedule/budget change → re-approval | planned | not_run | n/a | n/a | |
| CMP-07 | Tenant policy can forbid self-approval | P4 | Preparer≠approver enforced server-side | planned | not_run | n/a | n/a | |
| CMP-08 | `POST /launch` immediately creates exactly one execution, even for a future time | P4 | Unique `(tenant_id, campaign_id)` execution; concurrent launches → one | planned | not_run | n/a | n/a | |
| CMP-09 | Post-launch edits to audience/content/variables/schedule/expiry/budget rejected | P4 | Typed state conflict | planned | not_run | n/a | n/a | |
| CMP-10 | Clone creates a new ID; never copies execution state/approvals/idempotency results | P4 | Clone test | planned | not_run | n/a | n/a | |
| CMP-11 | Scheduler uses trusted UTC, version checks, durable restart recovery | P4 | Restart mid-schedule test | planned | not_run | n/a | n/a | |
| CMP-12 | IANA timezone + explicit DST behaviour + quiet hours + expiry | P4 | DST gap/overlap tests | planned | not_run | n/a | n/a | |
| CMP-13 | Cursor batching, bulk insert, bounded buffers, explicit `max_in_flight` | P4 | 1M recipients with flat memory | planned | not_run | n/a | n/a | |
| CMP-14 | Postgres recipient/attempt ledger durable; queue carries small refs; row claims + leases | P4 | Duplicate work prevented under restart | planned | not_run | n/a | n/a | |
| CMP-15 | Hierarchical fairness: tenant → connection → traffic class; separate pools | P4 | CMP-06 fairness scenario measured | planned | not_run | blocked_env | n/a | |
| CMP-16 | Interactive reservation (initial hypothesis 20%) with borrowing when idle | P4 | Interactive p95 held under bulk load | planned | not_run | blocked_env | n/a | |
| CMP-17 | Budget in exact decimal minor units; estimated/reserved/committed/reconciled distinct | P4 | Conservation property test; no float | planned | not_run | n/a | n/a | |
| CMP-18 | Reservation released exactly once for skipped/cancelled; held for unknown until reconciled | P4 | Property test | planned | not_run | n/a | n/a | |
| CMP-19 | Retry only classified retry-safe outcomes; honor Retry-After; jitter; cap; circuit breaker | P4 | Poisoned template stops | planned | not_run | n/a | n/a | |
| CMP-20 | Pause/cancel stops future permits; in-flight explicitly visible; no false final cancel | P4 | CMP-04 scenario | planned | not_run | n/a | n/a | |
| CMP-21 | `dispatch_completed` ≠ delivered; `outcome_unknown` visible after completion | P4 | Counter semantics test | planned | not_run | n/a | n/a | |
| CMP-22 | Cumulative milestones vs disjoint current-state counts with published denominators | P4 | No accepted+delivered summing | planned | not_run | n/a | n/a | |
| CMP-23 | Recipient drill-down, error categories, progress freshness, safe export | P4 | Scoped export job | planned | not_run | n/a | n/a | |
| CMP-24 | Failed-only safe retry on the same execution and ledger | P4 | Completed/unknown not resent | planned | not_run | n/a | n/a | |
| CMP-25 | Reply attribution with documented evidence + configurable window; ambiguity preserved | P4 | Ambiguous case labelled ambiguous | planned | not_run | n/a | n/a | |
| CMP-26 | Versioned price cards by effective date/currency/category/market | P4 | Estimated vs actual billable separated | planned | not_run | blocked_no_asset | n/a | |
| CMP-27 | Operator runtime ceilings/kill switch can only restrict, never widen approved scope | P4 | Attempt to raise budget via ops control rejected | planned | not_run | n/a | n/a | |

## API — public API and outgoing webhooks

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| API-01 | `/api/v1` with pinned OpenAPI as contract source; CI fails on drift | P1→P5 | Spec lint + drift check in CI | implemented | passed | n/a | n/a | `docs/api/openapi.v1.json`; `api-contract.test.ts` checks OpenAPI version, operation IDs, responses, examples and closed schemas, then diffs actual Fastify routes against spec paths in both directions |
| API-02 | Full operation inventory of master §19 implemented, no undocumented helper routes | P5 | Route-vs-spec diff test | partial | passed | n/a | n/a | Every currently implemented route matches the pinned spec with no extra helper route. Full master inventory remains scheduled through P5 |
| API-03 | Canonical pagination envelope with opaque tamper-resistant cursors | P1 | Tampered cursor → typed error | implemented | passed | n/a | n/a | `apps/api/src/pagination.ts`; HMAC cursor binds tenant + filter + sort + position + expiry; tests cover tampering, wrong binding, malformed payload, expiry and canonical `data/page/request_id` output |
| API-04 | Canonical error envelope with stable machine codes + request_id | P1 | No secret/other-tenant existence leak | implemented | passed | n/a | n/a | Global Nest filter returns `{ error: { code, message, request_id, details } }`; integration covers parser, route, typed and unknown errors and proves driver text is hidden |
| API-05 | `Idempotency-Key` on mutating retryable commands: same key+body → same result; different body → conflict | P1 | Concurrent + crash tests | implemented | passed | n/a | n/a | Migration `0005` plus `IdempotencyService`; canonical HMAC-SHA-256 request fingerprint with a separate server secret and PostgreSQL unique scope; same/different/concurrent tests and a forced completion-write failure prove effect + stored result roll back together |
| API-06 | Idempotency retention covers the operation lifetime, not a fixed short TTL | P4 | Long-campaign key still protects | planned | not_run | n/a | n/a | |
| API-07 | Optimistic concurrency via `If-Match`/version preconditions on contested updates | P2 | Stale version → 409 | planned | not_run | n/a | n/a | |
| API-08 | 202 for async, 201 sync create, typed 4xx, 429 with guidance; never 200-with-hidden-error | P1 | Status code contract tests | partial | passed | n/a | n/a | Bootstrap returns 201; invalid request 400; invalid bootstrap credentials 401; reuse/already-used 409; unconfigured 503; unexpected failure 500. Async 202 and rate-limit 429 land with their first operations |
| API-09 | Async exports/imports/reports as jobs + `GET /operations/{id}` with ownership checks | P3 | Global ID bypass denied | planned | not_run | n/a | n/a | |
| API-10 | Parameterized SQL; configurable query expressions restricted to validated safe AST | P3 | Injection corpus test | planned | not_run | n/a | n/a | |
| API-11 | Outgoing webhooks: stable event_id, schema_version, occurred_at, scoped refs | P5 | Retry keeps same event_id | planned | not_run | n/a | n/a | |
| API-12 | HMAC over timestamp + raw body, rotation overlap, replay protection | P5 | Replayed old timestamp rejected | planned | not_run | n/a | n/a | |
| API-13 | Delivery history, exponential retry with jitter, DLQ, authorized replay | P5 | Replay requires explicit grant | planned | not_run | n/a | n/a | |
| API-14 | SSRF/DNS-rebinding/redirect protection at subscription time **and** per delivery | P5 | Rebinding test; private-range denied unless configured connector | planned | not_run | n/a | n/a | |
| API-15 | Sandbox + clearly labelled provider simulator; mock success never masquerades as live | P5 | UI/API label assertion | planned | not_run | n/a | n/a | |
| API-16 | Generated SDK/client used by the first-party UI (no divergent hand-written client) | P5 | UI compiles against generated types | planned | not_run | n/a | n/a | |
| API-17 | Copyable curl examples that actually run against a local/staging backend | P5 | Example-runner test | planned | not_run | n/a | n/a | |

## CRM — Odoo and integrations

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| CRM-01 | Odoo adapter selected by actual version/deployment (17 external RPC, 19 JSON-2) | P5 | Version discovery + capability probe | planned | not_run | blocked_no_asset | n/a | |
| CRM-02 | Model/field discovery + service-account permission test | P5 | Missing permission surfaced as actionable error | planned | not_run | blocked_no_asset | n/a | |
| CRM-03 | Contact match/create/update via explicit mappings | P5 | Mapping version recorded | planned | not_run | blocked_no_asset | n/a | |
| CRM-04 | Idempotent `crm.lead` creation keyed by stable operation key | P5 | CRM-01 scenario: timeout after possible write → no duplicate | planned | not_run | blocked_no_asset | n/a | |
| CRM-05 | Linked order/stage display with stale/error state and last-sync time | P5 | Downtime shows stale, not fake data | planned | not_run | blocked_no_asset | n/a | |
| CRM-06 | Conversation summary/link write under documented privacy scope | P5 | Private notes excluded by policy | planned | not_run | blocked_no_asset | n/a | |
| CRM-07 | Mapping/direction/source-of-truth/conflict/cursor/retry/pause/replay via UI+API | P5 | Conflict resolution endpoint | planned | not_run | n/a | n/a | |
| CRM-08 | `(tenant_id, integration_id, model, external_id)` external links | P5 | Unique constraint test | planned | not_run | n/a | n/a | |
| CRM-09 | Loop prevention via origin/version/correlation | P5 | Bidirectional echo test | planned | not_run | n/a | n/a | |
| CRM-10 | Odoo downtime never stops the inbox | P5 | Circuit-broken integration, inbox green | planned | not_run | n/a | n/a | |
| CRM-11 | Incremental cursor `(write_date,id)` with overlap and dedupe when no events | P5 | Deleted record + schema drift handled | planned | not_run | blocked_no_asset | n/a | |
| CRM-12 | Generic connector contract: credential ref, test, schema, mapping, sync, health, audit | P5 | Second connector implementable without core change | planned | not_run | n/a | n/a | |

## AUTO / SLA / REP — operations

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| SLA-01 | Business hours, holidays, timezones per tenant/team | P6 | DST gap/overlap + holiday tests | planned | not_run | n/a | n/a | |
| SLA-02 | Capacity-based routing, round robin, least-open with documented tie-breaking | P6 | Hard capacity holds under concurrent claims | planned | not_run | n/a | n/a | |
| SLA-03 | Atomic assignment: never two agents, never over hard capacity | P6 | Race test | planned | not_run | n/a | n/a | |
| SLA-04 | Versioned SLA definitions: first reply, next reply, resolution | P6 | Bot-reply counting and pause statuses explicit | planned | not_run | n/a | n/a | |
| SLA-05 | Clocks stored as events, not mutable elapsed counters | P6 | Recompute from events matches | planned | not_run | n/a | n/a | |
| SLA-06 | Escalations/notifications durable, idempotent, scoped | P6 | Duplicate timer → one notification | planned | not_run | n/a | n/a | |
| SLA-07 | CSAT delivery obeys channel capability and policy | P6 | Unsupported channel → no attempt | planned | not_run | n/a | n/a | |
| AUTO-01 | Versioned triggers, typed conditions, allowlisted actions | P6 | No unrestricted custom JS in production worker | planned | not_run | n/a | n/a | |
| AUTO-02 | Draft/publish/rollback + simulator + per-run trace | P6 | Simulation performs no side effect | planned | not_run | n/a | n/a | |
| AUTO-03 | Cycle detection, max hops, deadlines, dedupe keys, budget | P6 | OPS-02 loop test terminates | planned | not_run | n/a | n/a | |
| AUTO-04 | Automations run under an explicit service identity + revision, not a browser cookie | P6 | Cookie expiry does not stop a published automation | planned | not_run | n/a | n/a | |
| REP-01 | Reports from derived read models; exports never monopolize the transactional DB | P6 | Resource isolation test | planned | not_run | n/a | n/a | |
| REP-02 | Every metric publishes numerator, denominator, timezone, excluded states, freshness | P6 | Docs + API metadata | planned | not_run | n/a | n/a | |
| REP-03 | Reconcile dashboards with deterministic fixture ledgers | P6 | Fixture-vs-dashboard equality test | planned | not_run | n/a | n/a | |
| REP-04 | Unsupported read receipts display `not_available`, never 0% | P6 | Channel capability drives display | planned | not_run | n/a | n/a | |
| REP-05 | Usage and cost reporting separating estimated from reconciled | P6 | Two columns, never merged | planned | not_run | n/a | n/a | |

## AI

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| AI-01 | Ownership model `bot_active/handoff_pending/human_active/bot_paused` + monotonic owner_version | P2 (hooks) / P7 | Audit trail per transition | planned | not_run | n/a | n/a | |
| AI-02 | Human takeover invalidates queued/outdated AI generations and blocks new bot permits | P7 | OWN-02 test | planned | not_run | n/a | n/a | |
| AI-03 | Serialized per-conversation gate orders ownership transitions vs external send starts | P7 | OWN-03 barrier test | planned | not_run | n/a | n/a | |
| AI-04 | In-flight bot send shows `handoff_pending` and never claims an atomic recall | P7 | Wording + state assertion | planned | not_run | n/a | n/a | |
| AI-05 | Bot resumes only by explicit authorized action; never by inbound or timeout | P7 | Negative tests | planned | not_run | n/a | n/a | |
| AI-06 | Tenant-scoped knowledge sources with versioning, ACLs, SSRF-safe ingestion | P7 | Cross-tenant retrieval empty | planned | not_run | n/a | n/a | |
| AI-07 | Deleted/revoked source disappears from retrieval and derived caches within documented bound | P7 | Timed test | planned | not_run | n/a | n/a | |
| AI-08 | Arabic lexical + dense retrieval, fusion, rerank; original Arabic preserved | P7 | Dialect/negation/number eval slices | planned | not_run | n/a | n/a | |
| AI-09 | Typed tools as scoped service users; server supplies tenant/policy, model cannot override | P7 | AI-01 injection test | planned | not_run | n/a | n/a | |
| AI-10 | Side-effect tools require deterministic authz, idempotency and argument-bound approval with expiry | P7 | Expired approval fails | planned | not_run | n/a | n/a | |
| AI-11 | Caps: turns, tokens, wall time, tool calls, concurrency, per-tenant spend | P7 | Budget exhaustion → fallback | planned | not_run | n/a | n/a | |
| AI-12 | AI failure/timeout/cost ceiling gives human fallback and never blocks ingestion or human reply | P7 | AI-02 test | planned | not_run | n/a | n/a | |
| AI-13 | Golden set (proposed 300 cases) with tracked metrics per language slice | P7 | Recorded scores, not claimed ones | planned | not_run | n/a | n/a | |
| AI-14 | Regression evals gate any model/prompt/retrieval/tool-policy change | P7 | CI job | planned | not_run | n/a | n/a | |
| AI-15 | Emergency AI stop independent of AI service health | P7 | Kill switch works while AI is down | planned | not_run | n/a | n/a | |

## UX

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| UX-01 | Design tokens derived from the Figma reference, measured vs estimated labelled | P0/P1 | `docs/design/design-reference.md` marks provenance per value | partial | passed | n/a | n/a | docs/design/design-reference.md §1, §4; apps/web/src/theme.ts; apps/web/src/theme.test.ts (19 tests). Provenance is still `original`/`a11y-override`, never `measured`: the Figma file remains 403 to automated fetch. The token layer is now single-source and drift-tested against styles/tokens.css. |
| UX-02 | Storybook/component catalogue with loading/empty/error/disabled/focus/permission/offline states | P1 | Every component has the applicable states | partial | passed | n/a | n/a | apps/web/src/styles/components.css implements default/hover/focus-visible/active/disabled per atom; loading, empty, offline, permission-denied captured as visual baselines in tests/e2e/visual.spec.ts (`state-*.png`). No Storybook binary yet — the baselines are the catalogue today. |
| UX-03 | Arabic RTL + English LTR via logical CSS and directional isolation for numbers/IDs/emails | P1 | UI-03 test | implemented | passed | n/a | n/a | apps/web/src/styles/* (logical properties only, enforced by theme.test.ts); `unicode-bidi: plaintext` on customer content; tests/e2e/layout.spec.ts asserts mirroring, glyph position for a mixed Arabic/Latin message, and Western digits in both directions. |
| UX-04 | Logos and media are never mirrored; hierarchy identical across directions | P1 | Visual diff both directions | implemented | passed | n/a | n/a | tests/e2e/layout.spec.ts "mirrors the shell without changing the hierarchy"; visual baselines exist for rtl/ltr × light/dark at 1440×900 and 1366×768. |
| UX-05 | Responsive 1280–1920 desktop; collapse contact panel → inbox drawer → single view | P2 | 375/768/1280/1440 + 200% zoom checks | implemented | passed | n/a | n/a | apps/web/src/styles/shell.css promotion thresholds (1260/1364/1596px) and drawer breakpoints (1027/719px); tests/e2e/layout.spec.ts covers tablet, phone and 200% zoom with no horizontal page overflow. |
| UX-06 | WCAG 2.2 AA: keyboard, names, contrast, focus, dialogs, live regions, non-colour status | P2→P8 | axe + manual keyboard evidence | partial | passed | n/a | n/a | tests/e2e/a11y.spec.ts — 22 checks, axe-core 4.10.2 at wcag2a/2aa/21a/21aa across 4 direction×theme combinations, 5 workspace screens, dialog and non-happy states; plus landmarks, heading order, icon-button names, Tab reachability, focus ring, Escape, reduced motion, 200% zoom. Contrast is additionally proved at the token level by apps/web/src/theme.test.ts. `partial` because this is AA-by-axe plus targeted manual assertions, not a full manual AT audit with a screen reader. |
| UX-07 | Reduced-motion respected; no decorative gradients/oversized KPI cards/marketing hero in-app | P1 | Visual review checklist | implemented | passed | n/a | n/a | apps/web/src/styles/base.css `prefers-reduced-motion` block asserted by tests/e2e/a11y.spec.ts; the broadcasts marketing hero and four oversized stat cards were removed from apps/web/src/ui/workspace.ts in favour of the shared compact `intro()` + `.metric` strip; largest type in the product is 18px. |
| UX-08 | Realistic synthetic Arabic/English content in all acceptance screenshots (no lorem, no invented stats) | P2 | Fixture review | implemented | passed | n/a | n/a | apps/web/src/data.ts is Digital School course/enrollment/support traffic; no Engosoft reference remains anywhere in the tree; 40 visual baselines under tests/e2e/visual.spec.ts-snapshots/. |
| UX-09 | Every UI action calls a real endpoint; no setTimeout backend, localStorage DB or premature success toast | P1→P8 | Static rule + e2e assertion | planned | not_run | n/a | n/a | |
| UX-10 | Figma attribution retained (CC BY 4.0 observed on the public page; re-verify current licence) | P0 | Attribution file present | partial | not_run | n/a | n/a | docs/design/design-reference.md §1. Still `partial`: the page is 403 to automated fetch, so the current licence could not be re-verified this session. Readex Pro ships with its own SIL OFL 1.1 text at apps/web/public/fonts/Readex-Pro-OFL.txt. |

## SEC — behavioural security matrix (master §13)

Each ID here maps 1:1 to the mandatory test matrix. These are release gates.

| ID | Scenario | Phase | Impl | Test | Evidence |
|---|---|---|---|---|---|
| SEC-01 | Cross-tenant object/list/search/export/media/socket/RAG access | P1→P7 | planned | not_run | |
| SEC-02 | Membership revoked while socket/job/session alive | P2 | planned | not_run | |
| SEC-03 | Role update / mass-assignment escalation attempt | P1 | planned | not_run | |
| EVT-01 | Invalid/missing signature or altered raw body | P2 | planned | not_run | |
| EVT-02 | Duplicate webhook across differently ordered batches | P2 | planned | not_run | |
| EVT-03 | Many entries/changes; one unsupported element | P2 | planned | not_run | |
| EVT-04 | Read before delivered; failed after confirmed delivery | P2 | planned | not_run | |
| TX-01 | Crash before DB commit | P2 | planned | not_run | |
| TX-02 | Commit ok, broker publish/confirm fails | P2 | planned | not_run | |
| TX-03 | Broker publishes, relay marker/consumer ACK lost | P2 | planned | not_run | |
| SEND-01 | Same idempotency key/body concurrently | P2 | planned | not_run | |
| SEND-02 | Same key, different body | P2 | planned | not_run | |
| SEND-03 | Provider may accept, response lost | P2 | planned | not_run | |
| SEND-04 | Window closes / identity changes while queued | P2 | planned | not_run | |
| CMP-T01..07 | Campaign matrix CMP-01..CMP-07 of master §13 | P4 | planned | not_run | |
| OWN-01..03 | Claim race, stale AI result, takeover during in-flight send | P2/P7 | planned | not_run | |
| CRM-T01..02 | Lost create response; bidirectional drift | P5 | planned | not_run | |
| ID-01 | No phone, BSUID rotation, duplicate name | P3 | planned | not_run | |
| UI-01..03 | Offline/reconnect drafts; private note attachment; RTL + 200% zoom | P2 | planned | not_run | |
| OPS-01..02 | DST/holiday/reopen/capacity race; automation loop | P6 | planned | not_run | |
| DR-01..02 | Restore + replay; opt-out and accepted send after recovery point | P8 | planned | not_run | |
| AI-T01..02 | Injection tool escalation; LLM timeout fallback | P7 | planned | not_run | |

## DEP — build, release, operations

| ID | Requirement | Phase | Acceptance | Impl | Test | Live | Dep | Evidence |
|---|---|---|---|---|---|---|---|---|
| DEP-01 | Separately scalable process roles: api, ingress, realtime, workers (inbound/interactive/campaign/integration), ai | P1 | Each role has own concurrency/queue/resource config | partial | passed | n/a | n/a | `apps/api` requires `CONVO_PROCESS_ROLE=api` and refuses other roles before boot. Remaining role-specific processes and queue/concurrency configuration are not built yet |
| DEP-02 | Expand/backfill/contract migrations; cancellable throttled backfills; idempotent migrate command | P1 | Rollback drill | partial | passed | n/a | n/a | `packages/database/src/migrate.ts`; `tests/integration/migrate.test.ts` — fresh apply, re-apply is a no-op, an edited applied migration is rejected, a failing file rolls back wholly and records nothing. **Still missing: expand/backfill/contract pattern and cancellable throttled backfills** — no backfill exists to throttle yet |
| DEP-03 | Readiness/liveness separation, graceful drain, deterministic rollback | P8 | Drain test loses no accepted work | planned | not_run | n/a | not_deployed | |
| DEP-04 | OpenTelemetry traces/metrics/log correlation with redaction; no unbounded label cardinality | P1→P8 | Label cardinality test | planned | not_run | n/a | n/a | |
| DEP-05 | Dashboards + burn-rate alerts on symptoms with runbook links | P8 | Alert rules reviewed | planned | not_run | n/a | not_deployed | |
| DEP-06 | Global / per-tenant / per-channel kill switches with audit, independent of AI health | P4 | Kill switch test | planned | not_run | n/a | n/a | |
| DEP-07 | Postgres HA/PITR, broker quorum, object-store redundancy, KMS-managed secrets | P8 | Config + drill evidence | planned | not_run | n/a | not_deployed | |
| DEP-08 | Key rotation and recovery plan (not one unrecoverable env secret) | P8 | Rotation drill | planned | not_run | n/a | not_deployed | |
| DEP-09 | Restore drill measuring RPO/RTO with `recovery_hold` outside the restored snapshot | P8 | DR-01/DR-02 evidence | planned | not_run | n/a | not_deployed | |
| DEP-10 | Load/soak profiles executed on disposable/staging with offered vs achieved rates | P8 | k6 artifacts + integrity reconciliation | planned | not_run | n/a | not_deployed | |
| DEP-11 | Load/recovery commands fail fast if pointed at production | P8 | Guard test | planned | not_run | n/a | n/a | |
| DEP-12 | The 14 required runbooks of master §12 | P8 | Files present and exercised where possible | planned | not_run | n/a | not_deployed | |
| DEP-13 | SBOM, dependency licences, pinned versions, secret/dependency/SAST scans in CI | P1→P8 | CI artifacts | planned | not_run | n/a | n/a | |
| DEP-14 | Coverage gates: 100% line/function first-party, 100% branch critical modules, ≥95% branch overall | P1→P8 | Coverage artifact per run; every exclusion reported | implemented | passed | n/a | n/a | `vitest.config.ts` (global + per-file glob thresholds); `pnpm test:coverage` exit 0 at 100/100/100/100 over 260 tests; artifact in `coverage/`; both process-entry exclusions (`bin.ts`, `main.ts`) are reported in `docs/testing/coverage-exclusions.md` and executed as built child processes |
| DEP-15 | Mutation testing on critical modules, proposed ≥90% score | P4 | Surviving mutants investigated | planned | not_run | n/a | n/a | |

---

## Descoped / deferred (P9 extension registry)

Kept visible on purpose. Not implemented, not advertised, not silently deleted.

| ID | Capability | Status |
|---|---|---|
| P9-01 | Web chat widget | registered, not scoped |
| P9-02 | Email channel | registered, not scoped |
| P9-03 | SMS channel | registered, not scoped |
| P9-04 | Telegram | registered, not scoped |
| P9-05 | LINE | registered, not scoped |
| P9-06 | Help center / knowledge portal | registered, not scoped |
| P9-07 | Calling | registered, not scoped |
| P9-08 | WhatsApp Flows | registered, not scoped |
| P9-09 | Product catalogs / commerce | registered, not scoped |
| P9-10 | Payment checkout, taxation, automated billing | explicitly separate connector decision (master §16) |
| P9-11 | Multi-connection inbox | requires ADR before modelling |
| P9-12 | Multi-region writes | requires confirmed requirement; single-region HA first |

A generic adapter existing is **not** an implemented channel. Promoting any row above into required scope adds its own contracts, UI, tests and live gate.
