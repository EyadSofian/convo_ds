# CONVO — Execution ledger

This is the handoff file. Read it first, then [traceability.md](../requirements/traceability.md), then the relevant phase card in `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md`.

---

## Last completed task — P1-T5 second slice (Milestone B: password recovery)

**Task / requirement IDs:** IAM-03 closed. API-02 incremental (two routes documented and drift-checked).

### Behavior delivered

**The start endpoint is not an oracle.** `POST /auth/recovery` always returns 202 with the same body — for a known address, an unknown one, and a rate-limited one. A 429 here would tell an enumerator they had found a real, rate-limited target, so the delay is advertised through the limiter and the existence of the account never is. The integration test compares the **whole response body byte for byte** rather than reading the code.

**A decoy challenge is written for an unknown address**, with a NULL user, so the table's shape and growth do not reveal which addresses are real. Nothing is delivered for it.

**Only fingerprints are stored.** The raw token exists long enough to hand to the delivery port and is never written, logged or returned. The database holds a 64-hex HMAC under a server secret, asserted directly.

**Completion is one transaction.** The challenge is claimed with a conditional UPDATE — two concurrent requests holding the same token cannot both win — then the password is replaced, every session for the account is revoked, and every other outstanding challenge is spent. A password change that leaves an attacker's session alive has changed nothing.

**Delivery is a port, and it is not wired.** `LoggingRecoveryDelivery` logs a redacted address and never the token, and deliberately does not throw: a recovery request must look identical whether or not delivery is configured. It is **not** an email integration and is recorded as unconfigured. `createApiApplication` now takes an `adapters` argument, because the composition root is where an outbound integration is chosen.

**A branch was deleted rather than tested.** The first implementation handled a decoy token in `complete()` with its own branch — code no request could reach, since decoy tokens are never delivered. The requirement moved into the claiming predicate (`AND user_id IS NOT NULL`), so a guessed decoy token is refused by exactly the same path as an unknown one. One path cannot drift from another.

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | |
| `pnpm test:unit` | **0** | 46 files, **664 tests** |
| `pnpm test:integration` | **0** | 15 files, **111 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 61 files, **775 tests**, **100% lines / statements / functions**, 98.95% branches |

### Honest remaining scope

- **No email provider is configured.** The port exists and is exercised by a capturing adapter in tests; in production nothing is sent. A real adapter and its credentials are an open dependency.
- MFA (IAM-04) is not implemented, so recovery is the only account-recovery path.
- Invitations (IAM-06) remain `planned`.

---

## Previously completed — P1-T5 first slice (Milestone B: the role boundary)

**Task / requirement IDs:** IAM-09, IAM-10, IAM-15 closed. IAM-14, IAM-16, IAM-17 moved to `partial` with the enforced half named. IAM-03 and IAM-06 remain `planned` — see "Honest remaining scope".

### Behavior delivered

**The matrix exists once.** `packages/domain/src/iam/roles.ts` holds the seven built-in roles as data, transcribed from `business-rules.md` §7. `roles.test.ts` asserts every cell against that table *and* parses `packages/database/migrations/0007_role_matrix.sql`, so the module, the document and the database are held together by two mechanical checks rather than by discipline. Platform Super Admin is deliberately not one of the seven.

**Authorization is an intersection, and it can only narrow.** `packages/domain/src/iam/authorize.ts` implements invariant I3 as five sequential terms: active membership ∩ tenant status ∩ action grant ∩ delegation ceiling ∩ resource scope. No branch widens a decision. A `Principal` carries grants by key, not a role label, so there is nowhere to write `if (role === 'admin')`. 41 unit tests cover each term, `own` reached by assignment and by prior participation, lost inbox access overriding assignment, an empty ceiling meaning "nothing", and a 7-role × 29-key sweep.

**A defect the tests found.** The denial reason was originally derived from the grant level, so an agent who had lost inbox access was reported as `not_own_resource`. It now names the term that actually failed — the operator's next step and the audit line differ between "ask for the inbox back" and "this is not your conversation".

**Scope levels are stored.** Migration 0007 adds `scope_level` to `role_permissions`; until now a grant carried no scope and every grant behaved as tenant-wide. `none` is absent from the CHECK on purpose: a denial is the absence of a row.

**The last Owner is protected by the database.** `memberships_keep_an_owner` is a DEFERRABLE INITIALLY DEFERRED constraint trigger, not a service check — two concurrent transactions each removing "the other" Owner would both pass an application check. Deferring to commit is what makes a legitimate transfer (demote A, promote B) legal while committing with no Owner is not.

**One HTTP entry point to the engine.** `apps/api/src/authorization/authorization.service.ts` loads the principal inside the same RLS transaction the work runs in, so a membership revoked between check and write cannot be used. Non-membership, revoked membership and inactive tenant all conceal as 404; 403 is reserved for a member whose action is denied. `PermissionService` previously inlined its own `role.manage` query — correct for one route, and the start of a per-endpoint copy of the rules.

**Three routes, documented and drift-checked:** `GET /tenants/{tenantId}/roles`, `/people`, `/teams`. The pinned OpenAPI now also pins that `scope_level` admits only `tenant|scoped|own`.

### Main files

| Path | Purpose |
|---|---|
| `packages/domain/src/iam/permissions.ts` | the 29 keys and the non-delegable set, checked against migration 0003 |
| `packages/domain/src/iam/roles.ts` | the seven roles as data, checked against §7 and migration 0007 |
| `packages/domain/src/iam/authorize.ts` | the I3 intersection, field projection, queue-card allowlist |
| `packages/database/migrations/0007_role_matrix.sql` | `scope_level`, reference matrix, per-tenant seeding, last-Owner trigger |
| `packages/domain/src/installation/bootstrap.ts` | seeds all seven roles at company creation |
| `apps/api/src/authorization/authorization.service.ts` | principal loading and the single decision point |
| `apps/api/src/authorization/permission.service.ts` | permissions / roles / people / teams read models |
| `tests/integration/api-authorization.test.ts` | the database half: seeding, gating, concealment, last-Owner, pooled isolation |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | all packages and the web bundle |
| `pnpm test:unit` | **0** | 46 files, **664 tests** |
| `pnpm test:integration` | **0** | 14 files, **98 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 60 files, **762 tests**, **100% lines / statements / functions**, 99.02% branches |
| `pnpm test:e2e` | **0** | 146 tests, unchanged |
| `pnpm test:a11y` | **0** | 22 tests, unchanged |

### Honest remaining scope after this slice

- **Password recovery (IAM-03) is still `planned`.** The hash-only schema from 0006 exists; there is no start/complete HTTP behaviour and no delivery port.
- **Invitations (IAM-06) are still `planned`.** No table, no routes.
- **Custom-role creation is not implemented.** The delegation ceiling is *enforced* by the engine, but there is no write path that mints a custom role, so IAM-14 is `partial`.
- **Ownership transfer is half done.** The transactional guarantee is proven; recipient acceptance, decline, expiry and the fresh-MFA gate are not built (IAM-16 `partial`, IAM-04 `planned`).
- **There is no People/Roles/Teams UI.** `apps/web` is still the demo from Milestone A and is not wired to these endpoints. UX-09 stays `planned`.
- `delegationCeiling` is `null` for every session principal, because API keys do not exist yet (P5).

---

## Previously completed — P1-T6 (Milestone A: the daily operator UI)

**Task / requirement IDs:** UX-01, UX-02, UX-03, UX-04, UX-05, UX-06, UX-07, UX-08, UX-10. UX-09 is deliberately **not** claimed — see "Honest remaining scope".

**Source state:** uncommitted working tree on `main` after `4d2b851`, extended in place. Nothing was reset, cleaned or discarded. macOS 25.6.0 arm64, Node v22.23.2, pnpm 9.12.0, PostgreSQL 17.4 in-process via `embedded-postgres`, Chromium 140.0.7339.16 via Playwright 1.55.0. No Docker.

### Behavior delivered in Milestone A

**One stylesheet architecture, one token layer.** `apps/web/src/styles.css` was a 3,668-line append-only monolith carrying **three** competing `:root` token blocks (lines 8, 2432, 3597), an `!important` tail and three font families. It is now a 29-line entry point that declares `@layer tokens, base, shell, components, screens;` and loads five files. No patch block was appended; the old monolith was replaced, not extended. The renderer was **not** migrated to React — the existing strict-TypeScript renderer was kept and extended, so the tree holds exactly one UI architecture.

**Colour is data, and contrast is a test.** `src/theme.ts` holds both palettes plus the WCAG requirement list; `src/theme.test.ts` parses `styles/tokens.css`, fails on drift, and re-checks **37 pairs on both themes** — 0 failures. It also proves the checker can fail (`contrastFailures` takes an injectable palette), forbids hard-coded colour outside the token layer, and forbids physical `left`/`right` in layout CSS. A dark theme exists for the first time.

**Typography.** One Arabic-first family, Readex Pro, self-hosted from `apps/web/public/fonts` under SIL OFL 1.1 with the licence text beside the files. No third-party font host is contacted, so a self-hosted install opens with no outbound call. Alexandria, IBM Plex Sans Arabic and Manrope are gone from the tree.

**Western digits at the formatter.** `numberFormat` / `dateFormat` in `src/format.ts` pass `numberingSystem: 'latn'` explicitly rather than relying on a `-u-nu-latn` locale extension, which is silently dropped when a caller passes a plain tag. `data.ts` no longer builds its own `Intl` instance. No fixture string was edited.

**Layout and density.** Shell is exactly `100dvh` with no page-level scrolling; rail 56px; top bar 48px; conversation header ≤64px on one row; queue rows a fixed 68px with a genuinely single-line preview; composer 117px at rest (cap 118) growing to 88px; both optional side zones closed on arrival; focus mode; `Escape` unwinds dialog → menu → side zones; the queue list is resizable 300–380px by pointer and by keyboard through a real `role="separator"`.

Whether an open side zone is an inline column or a drawer is decided in CSS by arithmetic from the 640px timeline floor — promotion at 1260 / 1364 / 1596px, drawers below 1027 / 719px — so the threshold exists once, not once in CSS and once in JavaScript. The viewport probe was removed from `app.ts` for exactly that reason.

**Defects found by measuring, then fixed.** The composer was 133px because `.composer__area` was laid out as a flex *row*, putting the toolbar beside the textarea. The queue showed 7 rows, not 8, because a wrapping filter bar cost 150px and a redundant meta strip cost another 28px. The timeline showed 6 groups, not 7.

**Defects found by looking at the screenshots, then fixed.** An Arabic customer message rendered with an LTR base direction inside the English UI, visually reordering the sentence — fixed with `unicode-bidi: plaintext` on customer content, and asserted by measuring where the first strong glyph lands. Queue-row cues were sheared mid-word — row anatomy is now capped at assignee plus two cues plus a count, with labels moved to the customer panel where the brief puts them. The thread header crowded out the contact name.

**Defects found by axe, then fixed in the DOM.** `role="list"` without `listitem` children; two scrollable regions with no keyboard access; an unstyled `.filterbtn` falling back to user-agent chrome that failed AA in dark; and an analytics bar chart painting its numeric label on the accent fill (a class mismapping — `.bars__value` is the label, `.bars__fill` is the bar).

### Main files

| Path | Purpose |
|---|---|
| `apps/web/src/styles.css` | 29-line entry: cascade order plus five imports, no declarations |
| `apps/web/src/styles/{tokens,base,shell,components,inbox,workspace}.css` | the five layers |
| `apps/web/src/theme.ts`, `theme.test.ts` | palette as data, contrast requirements, drift and contrast gate |
| `apps/web/src/format.ts` | `numberFormat` / `dateFormat` pinned to `latn` |
| `apps/web/src/app.ts` | Escape handling, pointer/keyboard list resize, composer auto-grow; viewport probe removed |
| `apps/web/src/state.ts`, `actions.ts` | side zones closed by default, focus mode, list-width clamp |
| `apps/web/src/ui/inbox.ts` | scrims, resizer, focus toggle, capped row cues, list semantics, focusable timeline |
| `apps/web/src/ui/workspace.ts` | marketing hero and KPI wall replaced by the shared compact header and `.metric` strip |
| `apps/web/public/fonts/` | Readex Pro subsets plus `Readex-Pro-OFL.txt` |
| `playwright.config.ts`, `tsconfig.e2e.json` | two mandated viewports, built bundle under test |
| `tests/e2e/layout.spec.ts` | 64 density and geometry assertions |
| `tests/e2e/a11y.spec.ts` | 22 accessibility checks, axe-core 4.10.2 |
| `tests/e2e/visual.spec.ts` | 19 baselines per viewport, 40 committed PNGs |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects, including the new `tsconfig.e2e.json` |
| `pnpm build` | **0** | CSS 44.83 kB (7.70 kB gzip) |
| `pnpm test:unit` | **0** | 44 files, **580 tests** |
| `pnpm test:integration` | **0** | 13 files, **82 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 57 files, **662 tests**, **100% lines / statements / functions**, 98.97% branches (threshold 95) |
| `pnpm test:e2e` | **0** | **146 tests** across 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **22 tests**, 0 axe violations at wcag2a/2aa/21a/21aa |

No threshold was lowered and no exclusion was added. `apps/web/src/theme.ts` reached 100% only after `contrastFailures` was made palette-injectable so its failure path could actually execute.

Three placeholder scripts that previously exited 1 with `not_run` are now real runs: `test:e2e`, `test:a11y`, and the new `test:visual`. `test:contracts`, `test:security`, `test:mutation`, `test:load:target` and `test:recovery` still exit 1 honestly — their product surfaces do not exist yet.

`eslint.config.js` gained ignores for `tmp/`, `coverage/`, `playwright-report/`, `test-results/` and `deliverables/`. These are already in `.gitignore`; eslint 9's flat config does not read that file, and a scratch file under `tmp/` (not created by this task) was failing `pnpm lint`.

### Honest remaining scope after Milestone A

- **`apps/web` is still a client-facing demo.** UX-09 stays `planned`. Channel connection, invitations, team/member edits, campaign launch, exports and settings remain demo/no-op behaviour. Nothing in this milestone wired a UI action to a backend endpoint, and nothing here may be described as a live omnichannel product.
- No API surface changed, so `docs/api/openapi.v1.json` is unchanged and the bidirectional route/spec drift test in `tests/integration/api-contract.test.ts` passed unchanged. There was no drift to fix.
- UX-06 is `partial`, not `implemented`: this is AA-by-axe plus targeted manual assertions, not a full manual audit with a real screen reader.
- UX-01 and UX-10 stay `partial`: the Figma file is still HTTP 403 to automated fetch, so there are still **zero** `measured` token values and the licence could not be re-verified.
- Five of the nine mandated research URLs were blocked this session (two Chatwoot timeouts, two client-rendered Postman pages, one Meta 400). Recorded per-URL in `docs/design/ui-research.md` §5a. None of them blocks Milestone A; they matter to Milestone C.
- The visual baselines are `darwin`-tagged. A Linux CI run will need its own baselines or a container that matches the font rasteriser.

---

## Previously completed — P1-T4

**Task / requirement IDs:** local authentication, durable sessions and first permission boundary. IAM-01, IAM-02, IAM-05, IAM-07, IAM-08, API-02 (incremental), API-04, API-08, DEP-14. IAM-03 is schema-only and remains open.

**Source state:** uncommitted working tree on `main` after `4d2b851`; it contains P1-T2 through P1-T4. Do not discard or overwrite the dirty tree. macOS 25.6.0 arm64, Node v22.23.2, pnpm 9.12.0, PostgreSQL 17.4 started in-process by `embedded-postgres`. No Docker was used.

### Behavior delivered in P1-T4

- Migration `0006_auth_sessions.sql` adds durable sessions, centralized login-rate buckets, hashed recovery challenges and a minimal global membership discovery index. Session/CSRF/IP/user-agent values are stored only as separate HMAC-SHA-256 fingerprints; raw bearer material never enters PostgreSQL.
- `POST /api/v1/auth/login` verifies Argon2id passwords with a valid dummy hash for unknown accounts, returns the same generic 401 for unknown/wrong/inactive users, creates a 12-hour server-side session, and sets SameSite=Strict cookies. The session cookie is HttpOnly; both cookies are Secure under HTTPS.
- `POST /auth/logout`, `GET /auth/session`, `GET /auth/sessions`, `GET /auth/sessions/{id}` and `DELETE /auth/sessions/{id}` implement current-session and owner-scoped inventory/revocation. Mutations require a cookie/header CSRF match; revocation applies on the next request and persists across API restart.
- Account and IP login limits use atomic PostgreSQL upserts so replicas share one decision. The sixth failed attempt in a 15-minute window returns typed 429 plus `Retry-After`.
- `GET /me/memberships` uses the minimal discovery index only to find tenant contexts, then resolves active membership, company and role fields inside FORCE RLS. Suspended membership is hidden.
- `GET /tenants/{tenantId}/permissions` is the first protected company boundary. It conceals a nonmembership as 404 and checks `role.manage` by permission key under RLS; it never compares role display names.
- The pinned OpenAPI 3.1 document now matches all ten implemented routes in both directions and documents cookie auth, CSRF, rate limiting and closed response schemas.

The P1-T3 HTTP/bootstrap behavior below remains part of the working tree:

- `apps/api` is a NestJS 11/Fastify 5 process with one required role, `CONVO_PROCESS_ROLE=api`. Configuration is validated and aggregated before a pool is opened. Startup refuses an invalid mode and refuses a configured mode that differs from the mode already recorded in PostgreSQL.
- `GET /api/v1/instance` reads the real bootstrap state and returns only the allowlisted public descriptor. Integration tests assert that database credentials and both application secrets cannot appear in the response.
- `POST /api/v1/instance/bootstrap` creates the company and Owner synchronously and exactly once. The app hashes the password with Argon2id before calling the domain; the domain still rejects a non-hash. Domain failures map to typed 400/409/503 responses.
- Bootstrap requires an installer-provisioned `X-Bootstrap-Token` of at least 32 bytes. Missing and wrong values return the same 401 shape. Comparison uses fixed-length SHA-256 digests plus `timingSafeEqual`; the token is not written to PostgreSQL.
- Mutating bootstrap requests require `Idempotency-Key`. Migration `0005` stores pending/completed records under a `UNIQUE NULLS NOT DISTINCT` scope. FORCE RLS isolates tenant ledgers and exposes NULL pre-auth rows only while an explicit transaction-local installation scope is active. The transaction then switches to and verifies the generated tenant context before business writes. The effect and stored HTTP result commit together. Equal canonical bodies replay the first result; another body returns 409.
- The request fingerprint is HMAC-SHA-256 over recursively canonical JSON using a separate server secret. A database reader cannot use the stored fingerprint directly as an offline verifier for guessed owner passwords.
- Fastify generates or validates request IDs. Every failure path returns `{ error: { code, message, request_id, details } }`; synchronous creation returns 201 with `request_id`. Unknown framework/driver errors are reduced to safe public messages.
- `docs/api/openapi.v1.json` is the pinned OpenAPI 3.1 contract for every implemented route. A route inventory hook diffs real registered Fastify routes against the spec in both directions and also pins operation IDs, response codes, examples and closed response schemas.
- The canonical pagination utility produces the required `data/page/request_id` envelope and HMAC-signed opaque cursors bound to tenant, filters, sort, position and expiry. Tampering, wrong bindings, malformed cursors and expiry are covered before the first list route uses it.

### Main files

| Path | Purpose |
|---|---|
| `apps/api/src/app.ts`, `config.ts`, `api.module.ts`, `main.ts` | boot boundary, strict environment, process entry point |
| `apps/api/src/auth/`, `memberships/`, `authorization/` | login, session/CSRF boundary, shared rate limits, tenant membership resolution and permission enforcement |
| `apps/api/src/instance/` | public descriptor, authenticated first-run bootstrap, validation and response mapping |
| `apps/api/src/idempotency/` | canonical keyed fingerprint and transactional replay service |
| `apps/api/src/error.filter.ts`, `request-id.ts`, `pagination.ts`, `route-inventory.ts` | global HTTP contracts |
| `packages/database/migrations/0005_idempotency.sql`, `0006_auth_sessions.sql` | durable idempotency, session/recovery verifiers, abuse buckets and membership discovery |
| `docs/api/openapi.v1.json` | pinned contract source for implemented v1 routes |
| `tests/integration/api-auth.test.ts` | login, hashing, cookies, CSRF, memberships, allow/deny, restart, revocation and 429 journey |
| `tests/integration/api-instance.test.ts` | public descriptor, bootstrap auth, hashing, replay, concurrency and typed failures |
| `tests/integration/api-idempotency-rollback.test.ts` | injected completion-write failure proving effect and key roll back together |
| `tests/integration/api-boot.test.ts`, `api-contract.test.ts` | real boot/process behavior and route/spec drift |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | strict build graph plus tests project |
| `pnpm build` | **0** | all packages and API emitted |
| `pnpm test:unit` | **0** | 27 files, **217 tests** |
| `pnpm test:integration` | **0** | 13 files, **82 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 40 files, **299 tests**, **100% lines / statements / functions / branches** |

The rollback fault test installs a trigger that deliberately rejects the update from `pending` to `completed`. The HTTP request returns a safe 500; the company, Owner and idempotency row are all absent; `bootstrap_state` remains `pending`; removing the fault and retrying the same key succeeds. This is the crash/atomicity evidence for API-05.

Two source entry points are excluded from in-process instrumentation: `packages/database/src/bin.ts` and `apps/api/src/main.ts`. Both are exercised as built child processes; all decidable logic behind them remains inside the 100% gate. The exact rationale is in [coverage-exclusions.md](../testing/coverage-exclusions.md).

### Honest remaining scope after P1-T4

- API-02 remains partial because the master inventory spans later phases. The drift test guarantees that every route implemented today is documented; it does not claim the future routes exist.
- API-08 remains partial until the first async 202 operation exists; the abuse-limited 429 path is implemented.
- DEP-01 remains partial until ingress, realtime and worker roles have separate processes and concurrency/queue configuration.
- IAM-03 recovery has a hardened hash-only schema but no start/complete HTTP behavior or delivery adapter yet. Invitations, MFA, the seven-role matrix, scope intersections, last-Owner protection and ownership transfer remain P1 work.
- DEP-02 still lacks a real expand/backfill/contract migration and cancellable throttled backfill. The migration runner itself is tested for apply, checksum, reapply and transactional failure.
- There are no channel adapters, inbox, broadcasts, frontend or deployment yet. There is no provider-live verification. The open external dependencies below do not block the next local P1 task.

---

### Previously

**P1-T3** — first NestJS/Fastify HTTP surface, bootstrap token and atomic HMAC-bound idempotency, request/error/pagination contracts and bidirectional OpenAPI drift protection.

**P1-T2** — closed DEP-14 at 100/100/100/100 without lowering thresholds; extracted the pure DB CLI, executed migration/bootstrap code in-process on throwaway databases, implemented validated installation mode and one-time bootstrap, and enforced the self-hosted one-company invariant in PostgreSQL.

**P1-T1 (commit `4d2b851`)** — workspace foundation, initial tenancy schema, runtime role and RLS harness. Closed with 18 PostgreSQL integration tests and the then-failing coverage gap reported honestly.

**P0 (commit `adf5462`)** — requirement registry, business rules, architecture and ADRs, data model, operation inventory, design-token evidence, testing strategy, threat model and provider evidence ledger.

---

## Open dependencies

These block only the named live/deployment checks. Independent implementation continues.

| # | Needed input | Blocks |
|---|---|---|
| 1 | Meta app, WABA, test phone number and authorized recipient | WhatsApp provider-live checks and authorized sends |
| 2 | Facebook Page, Instagram professional account and granted scopes | Messenger/Instagram provider-live checks |
| 3 | Odoo instance, version and service account | Odoo provider-live checks |
| 4 | Docker/OrbStack or reachable RabbitMQ and S3-compatible endpoint | broker/object-store contract checks |
| 5 | Disposable/staging infrastructure and k6 | load/soak SLO evidence |
| 6 | Figma connector authorization or exported reference in `docs/design/reference/` | measured design evidence; current tokens remain `estimated` |
| 7 | hosting region, domain, TLS and production authorization | deployment verification |
| 8 | OIDC identity provider | IAM-22 only; local auth proceeds |
| 9 | Email delivery provider and credentials | password-recovery **delivery** only; the port, the challenge lifecycle and every no-oracle guarantee are implemented and tested without it |

---

## Next task — P1-T5 remainder (Milestone B: invitations, the mutation surface and the People UI)

**Task:** the parts of Milestone B the role-boundary slice did not cover.

**Requirement IDs:** IAM-03, IAM-06, IAM-09, IAM-10, IAM-14, IAM-15, API-02 (incremental), API-05, DEP-14.

**Scope:**

1. ~~Complete generic password-recovery start/complete with single-use HMAC-only challenges, shared abuse limits, transactional password update plus session revocation, and an injectable delivery port whose production implementation never returns the token in HTTP.~~ **Done** (IAM-03). The delivery port is unwired: a real email adapter and its credentials are an open dependency.
2. Add tenant-scoped invitations with hashed single-use tokens, expiry, revoke and atomic accept. Known/unknown recovery and invite failures must not expose hidden account or tenant state.
3. ~~Seed the seven built-in tenant roles and their exact permission-key matrices; implement Tenant/Scoped/Own/No intersection without role-name authorization.~~ **Done** in the slice above (IAM-09, IAM-10).
4. **Partly done:** protected People/Roles/Teams *read* APIs and last-active-Owner protection are in place. Still open: the mutation surface (invite, change role, change scopes, create/edit a custom role within the delegation ceiling, ownership transfer with acceptance), all of it behind CSRF and idempotency where replay would otherwise duplicate an effect — plus the UI for these screens.
5. Exercise recovery, invite accept/reuse/expiry/revoke, every role/permission decision, privilege escalation attempts and concurrent last-Owner changes against real PostgreSQL and FORCE RLS.

**Exit checks:** the same six commands above, with coverage staying at 100/100/100/100. No open dependency blocks the internal implementation; real email delivery can remain behind the port until credentials exist.
