# CONVO — Execution ledger

This is the handoff file. Read it first, then [traceability.md](../requirements/traceability.md), then the relevant phase card in `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md`.

---

## Last completed task — P1-T7 (Milestone C: the channel foundation and the first inbound path)

**Task / requirement IDs:** CH-02, CH-03, CH-WA-02, CH-WA-04, DEL-02, DEL-05, DEL-06, EVT-01, EVT-02, EVT-03 closed. CH-00, CH-01, CH-05, CH-WA-03, CH-WA-05, DEL-01, DEL-03, DEL-04, DEL-07, DEP-01 moved to `partial` with the unbuilt half named. UX-09 gained its second wired screen.

### Behavior delivered

**One path, end to end.** Connect an asset → the provider delivers a signed webhook → the company is resolved from the asset inside it → the raw event is journaled → a normalized inbound event exists. 61 integration tests drive it against real PostgreSQL under FORCE RLS.

**A secret never sits in an ordinary column.** An app secret belongs to the installation, so `channel_apps` holds a *reference* to the configuration key it is read from plus a fingerprint of the value it was created against. A tenant's access token cannot live in configuration — it arrives from an OAuth grant — so it is AES-256-GCM ciphertext bound by additional authenticated data to its tenant, connection and purpose. A ciphertext lifted into another row does not decrypt; it breaks. Rotation appends a version and supersedes the previous one; there is no `DELETE` grant, because a revoked credential is evidence.

**The company comes from the payload, not the caller.** `channel_asset_registry` maps a provider asset to its owner across the whole installation, and its RLS policy admits exactly the row whose fingerprint the ingress derived from a signature-verified body. The test sends two forged tenant headers and asserts the receipt still records the real owner.

**A receipt and a payload are different facts.** `webhook_receipts` is installation-level, carries no content, and records every delivery including the refused ones — "we received bytes that failed to verify" is exactly what an operator needs when a provider claims it delivered. Content lives in a tenant-scoped row and only for a routable delivery: an asset nobody here has connected leaves a receipt, no content, and a 202.

**"Connected" is earned.** Five evidence timestamps, each written only by whatever observed it. `readinessOf` derives the state in one pure function the column and the screen share, so no endpoint can write `healthy`. A submitted form produces `authorization_needed` with four items missing.

**The ingress order is the design.** Raw bytes; HMAC over exactly those bytes, constant-time, with a replay window; company from the verified asset; journal; then ACK. Nothing is parsed until the signature holds — Nest's body parser is off and ours decides per route whether to parse or keep the buffer, because a signature over a re-serialized object verifies a document nobody signed.

**No simulator, deliberately.** The default transport refuses every send and connection test with `provider_not_connected`. One integration suite binds a labelled stub to exercise our own handling; it is bound nowhere in the shipped composition root.

**The Channels screen is wired, and the demo one is gone** — along with the `channel` demo action that answered four verbs with a warning toast. The token is dropped from form state whether the connect succeeds or is refused.

**The visual gate was broken and is fixed.** Replacing the Channels screen wholesale passed `toHaveScreenshot`. Measured: Arabic glyph jitter is ~1.4% of a text-dense screen and the replacement moved ~2%, so a pixel ratio cannot separate them. Every screen baseline is now paired with a **structural** snapshot — a DOM skeleton with all text removed — which rasterisation cannot move and a renamed action fails.

**Two gates stopped being `exit 1` echoes.** `test:contracts` and `test:security` are real. Wiring the audit found 9 high and 1 critical advisories in the HTTP stack — middleware and authentication bypasses in `@fastify/middie`, `fastify` and `@nestjs/platform-fastify` — and those are upgraded.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0010_channels.sql` | apps, connections, versioned credentials, the asset registry, receipts, events, the work queue, normalized inbound |
| `packages/database/src/context.ts` | the credential setting is a parameter now, so two carve-outs cannot widen each other |
| `packages/domain/src/channels/` | the versioned port, five capability matrices, the send policy, Meta signature verification, the WhatsApp normalizer |
| `apps/api/src/channels/credential-cipher.ts` | AES-256-GCM with a binding, a key version and an HMAC fingerprint |
| `apps/api/src/channels/ingress.service.ts` | verify → resolve → journal → ACK, in that order |
| `apps/api/src/channels/raw-body.ts` | one JSON parser; webhook routes keep the bytes |
| `apps/api/src/channels/normalization.service.ts` | the inbound worker, with a durable lease |
| `apps/web/src/ui/channels-screen.ts` | the screen; the demo one is gone |
| `tests/integration/api-channels.test.ts` | 61 tests: signature, replay, routing, dedupe, quarantine, isolation, lifecycle |
| `playwright.config.ts` + `tests/e2e/visual.spec.ts` | the structural snapshots that make the visual gate mean something |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 164.48 kB / 51.42 kB gzip |
| `pnpm test:unit` | **0** | 56 files, 984 tests |
| `pnpm test:integration` | **0** | 18 files, **230 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 74 files, **1214 tests**, 100% lines / statements / functions / branches |
| `pnpm test:contracts` | **0** | adapter + OpenAPI contract suites |
| `pnpm test:security` | **0** | isolation, authorization, signature suites + `pnpm audit --audit-level high --prod` |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 19, now including structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **40 operations**; the bidirectional route/spec drift test passes. Coverage stayed at 100% with no threshold lowered and no exclusion added.

### Honest remaining scope

- **No outbound path at all.** No outbox, no delivery state machine, no `outcome_unknown` handling in a real send, no per-conversation ordering. `permitSend` exists and is tested but is not wired to a send, so CH-WA-05's "draft preserved" is untested.
- **One adapter.** Messenger, Instagram, Website Chat and Custom Channel have matrices and policy but no adapter; connecting one is refused with a typed `not_supported`.
- **One process.** The seven roles are configurable and the inbound worker is a service with a durable lease, but they are not separate processes with their own queues.
- **No realtime**, no inbox, no contacts, no broadcasts, no CRM integration, no deployment configuration.
- **Every provider-live check is `blocked_no_asset`.** The signature scheme is genuinely verified against the documented algorithm; whether Meta's live deliveries match it needs an authorized app.

---

## Previously completed — P1-T5 fifth slice (Milestone B: the People screen, wired to the API)

**Task / requirement IDs:** UX-09 moved from `planned` to `partial` with the unwired screens named. IAM-14, IAM-15, IAM-16, IAM-24 gained their operator surface. API-02 incremental: two read models widened, one patch made genuinely partial.

### Behavior delivered

**The demo People screen was deleted, not left beside the real one.** Two implementations of one screen is how a demo ships by accident. `apps/web/src/ui/people-screen.ts` reads nothing from `data.ts`; the other five screens still do, and say so below.

**A list is a four-state resource**, not `data | null`: not asked, waiting, refused, here it is. "The server said no" and "there is nothing here" are different things to put in front of an operator, and a nullable field collapses them into one blank table. A denial renders as a permission state that says the refusal happened on the server — hiding a control is not an authorization control.

**Every mutation is pending → settle → toast.** Mark the specific control busy and re-render, await the server, then record success or the server's error. Nothing is written optimistically and no toast fires on click, because a toast on click is a claim the server has not made yet. `live.test.ts` holds a response open and asserts that the pending label is on the control, the button refuses a second click, and `state.toasts` is still empty — then that the toast appears only after the response commits. What is on screen after a change is what the reload returned, including fields the browser never asked about.

**Three defects the wiring exposed, all fixed at the cause:**

- Signing in resolved the session and stopped, so the lists sat on a skeleton until the operator reloaded by hand.
- A form key containing a colon (`teamMember:<id>`) collided with the `"<key>:<value>"` encoding the DOM uses to carry a form value, so the team-member select silently stored the wrong value under the wrong name. Both key builders are now in one place and asserted to contain no separator.
- `PATCH .../teams/{id}` demanded the team's name in order to archive it — which is how a team gets renamed by accident — and restoring a team whose name had since been reused returned a **500**. The patch is now partial (absent means "leave it alone", empty body is a 400), and the partial unique index's refusal is translated into the same `409 team_exists` the create path gives, by a shared helper that rethrows every other failure untouched.

**Two read models grew, for the same reason in both cases: a control existed with no honest way to reach it.** `GET .../teams` now returns each team's `members` and `archived` flag, so a card that said "3 members" can show who they are and remove one. The custom-role editor offers exactly the **delegable** keys from `GET .../permissions` instead of four hard-coded strings, and is disabled until a key and a scope are chosen — a convenience, not the control, since `canAuthorRole` still refuses on the server.

**One same-origin path in development and in production.** `apps/web/vite.config.ts` proxies `/api` to the running API, so the client only ever knows `/api/v1/...`. A second base URL that exists only locally brings a class of CORS and cookie bugs that never appear in the deployed build.

### Main files

| Path | Purpose |
|---|---|
| `apps/web/src/api/client.ts` | the HTTP boundary: results not exceptions, parsed error envelope, CSRF on every mutation |
| `apps/web/src/api/people.ts` | one named function per documented endpoint, plus `disconnectedApi()` |
| `apps/web/src/live/store.ts` | four-state resources, session state, `rowsOf` |
| `apps/web/src/live/actions.ts` | the pending/settle/toast discipline, in one place |
| `apps/web/src/live/dispatch.ts` | the `live-*` action table and the form-key vocabulary |
| `apps/web/src/ui/people-screen.ts` | the screen; the demo one is gone |
| `apps/api/src/pg-error.ts` | one named constraint violation → the API error it means |
| `apps/web/vite.config.ts` | `/api` proxy, so the browser path is the same in both environments |
| `apps/web/src/live/live.test.ts` | 37 tests driving the real client, actions and renderer over a scripted server |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 154.96 kB / 49.18 kB gzip |
| `pnpm test:coverage` | **0** | 71 files, **1007 tests**, 100% lines / statements / functions / branches |
| `pnpm test:unit` | **0** | 54 files, 838 tests |
| `pnpm test:integration` | **0** | 17 files, 169 tests against real PostgreSQL 17.4 |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |

The pinned OpenAPI still carries **32 operations**; the bidirectional route/spec drift test passes. Coverage reached 100% with no threshold lowered and no exclusion added: the remaining gaps were closed by deleting a dead helper (`scopeList`), replacing three copies of the same `status === 'ready' ? … : []` ternary with one tested `rowsOf`, and moving the untyped-`catch` guard into `pg-error.ts` where all three of its arms are asserted directly.

### Honest remaining scope

- **UX-09 stays `partial`.** Inbox, Channels, Broadcasts, Analytics and Settings are still backed by `data.ts`. A workspace that never opens People makes no request at all — asserted, not assumed.
- The People screen needs a running API to do anything. With none, it reports a network failure, which is what a page with no server behind it should show.
- No channel adapters, no webhooks, no realtime, no workers, no broadcasts, no CRM integration, no deployment configuration. No provider-live verification of any kind.

---

## Previously completed — P1-T5 fourth slice (Milestone B: the mutation surface)

Twelve routes behind CSRF: change a membership's role, status or scopes; create, replace and delete a custom role; create, rename, archive a team and move people in and out; offer, accept, decline and cancel ownership. None carries an `Idempotency-Key`, because none duplicates an effect on replay. Migration 0009 makes built-in roles and their grants immutable by admitting exactly the rows that already exist in `builtin_role_grants` — which permits the per-tenant seed, refuses an added key, a widened scope, an edit and a delete, **and** catches a seed that disagrees with the matrix. Ownership transfer is an offer the recipient accepts; offering requires `tenant.delete`, so "only an Owner may transfer" holds without any code naming the role. Every mutation writes an `admin_audit_events` row in the same transaction as its effect. Commit `a590d12`. Gates: 67 files, 940 tests, 100/100/100/100.

---

## Previously completed — P1-T5 third slice (Milestone B: invitations, and a 100% coverage gate)

**Task / requirement IDs:** IAM-06 closed. IAM-14 moved to `partial` with the enforced half named. DEP-14 restored to a real 100/100/100/100 gate.

### Behavior delivered

**The coverage gate is honest again.** Branch coverage was 98.95% against a threshold of 95, so it could rot to 95 without failing anything. It is now 100% and the threshold says 100. Six of the twenty-two uncovered paths were **deleted as unreachable** rather than covered — a non-nullable `ownerDocument` fallback, a finite-by-construction guard, an attribute re-read that `closestWithAttr` had already proved present, an optional parameter every caller passes, a campaign-example lookup whose fallback key cannot be missing, and a tab fallback the guard above it prevents. The rest were covered with tests for behaviour that genuinely happens.

**Invitations store a fingerprint, never a token.** Creation requires `member.manage`, CSRF and an `Idempotency-Key`, and authorizes **inside** the idempotency transaction rather than opening a second one, so the record and the invitation commit together. A retry replays the first answer; a second invitation for the same address supersedes the first, because two live tokens for one seat are two ways in.

**The ceiling is arithmetic, not a list of role names.** An Admin cannot invite an Owner because Admin does not hold `tenant.delete`. A scoped inviter cannot grant an inbox they cannot see.

**Acceptance needed a new tenancy primitive.** `FORCE ROW LEVEL SECURITY` applies to the table owner, so a `SECURITY DEFINER` lookup could not read the invitation either — the first attempt at one was removed. `withCredentialResolvedTenant` sets a transaction-local credential fingerprint that the policy admits for exactly the row carrying that token, takes `FOR UPDATE`, then enters the tenant's normal context. One row wide, not a flag that opens the table.

**Accept requires a password in both cases** — creating the identity, or proving it. Otherwise holding the link would attach a stranger's established account to a company. Unknown, expired, revoked, already-used and wrong-password are byte-identical, and a wrong password does not burn the invitation. A successful accept clears the attempt counter so an office behind one IP can onboard ten people.

**A visual-regression flake was fixed at the cause.** The seeded dataset derives timestamps from `new Date()` at boot, so baselines drifted with wall-clock time. Playwright's clock is frozen before the bundle runs.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0008_invitations.sql` | invitations, scopes, ownership-transfer offers, the one-row RLS carve-out |
| `packages/database/src/context.ts` | `withCredentialResolvedTenant` — tenant resolved from a verified credential |
| `packages/domain/src/iam/delegation.ts` | `canAssignRole` / `canAuthorRole` / `canGrantScopes` |
| `apps/api/src/people/` | invitation service, request parsing, delivery port, controller |
| `apps/api/src/require-row.ts` | the impossible-row guard, in one tested place |
| `tests/integration/api-invitations.test.ts` | 23 tests against real PostgreSQL |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | |
| `pnpm test:coverage` | **0** | 65 files, **870 tests**, **100% lines / statements / functions / branches** |
| `pnpm test:integration` | **0** | 17 files, **156 tests** against real PostgreSQL 17.4 |
| `pnpm test:e2e` | **0** | 146 tests |
| `pnpm test:a11y` | **0** | 22 tests |

### Honest remaining scope

- **No email provider is configured**, so no invitation is actually delivered in production. Open dependency #9.
- The People/Roles/Teams **mutation** surface does not exist: role change, scope change, custom-role creation, team membership and ownership transfer are all still unimplemented. The `ownership_transfers` table exists but has no routes.
- There is **no People UI**. `apps/web` remains the demo; UX-09 stays `planned`.
- The invitation token travels in the URL path, as the task specifies. It is single-use, short-lived and rate-limited for that reason, and the OpenAPI description records that access logs must redact it.

---

## Previously completed — P1-T5 second slice (Milestone B: password recovery)

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

## Next task — Milestone C remainder (the outbound path and the other four adapters)

**Task:** the half of Milestone C the inbound slice did not cover.

**Requirement IDs:** CH-WA-01, CH-MSG-01…03, CH-IG-01…04, CH-04, DEL-07…DEL-22, SEND-01…04, EVT-04, API-08 (202/429), DEP-01.

**Scope:**

1. The outbound path end to end: a permit that re-checks permission, window, consent, template and identity at dispatch time; an outbox row written in the same transaction as the domain effect; a durable attempt recorded **before** the network call; bounded retry with a lease; and the three-valued outcome, with `outcome_unknown` never blindly resent (ADR-0006).
2. Command state and provider delivery state as separate columns that fold independently, so a `read` arriving before its `delivered` leaves the timeline at `read` and a late `failed` never erases a confirmed delivery.
3. Messenger, Instagram, Website Chat and Custom Channel adapters — each with its own fixtures, its own policy and its own contract tests. Nothing inherited across them.
4. Realtime delivery to the browser, and the worker roles as separate processes with their own concurrency.
5. `202 Accepted` only after the durable transaction, and `429` with guidance.

**Exit checks:** the eleven commands above, with coverage staying at 100/100/100/100 and no exclusion added.

**Blocked, and stays blocked:** every provider-live check remains `blocked_no_asset` until a Meta app, WABA, test number, Page, Instagram professional account and authorized recipient exist. The outbound path will be built and tested against recorded contracts; **there is no provider simulator in the shipped composition root, and the default transport refuses every send.** A send that cannot reach a provider is reported as refused, never as sent.
