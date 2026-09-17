# Starting state — production hardening pass

Recorded before any file was modified. Nothing in the worktree was reset,
discarded or overwritten; a full tarball of the tree was taken first.

## Source control

| Fact | Value |
| --- | --- |
| Starting commit | `2aa0881e4b7221f5a37ec2fcff8ec9bd4e46989a` |
| Commit subject | `Apply Digital School brand and remove demo runtime` |
| Starting branch | `main` |
| Work branch created | `release/production-hardening` (from the same commit, dirty tree carried over intact) |
| Other branches | `redesign/operator-ui` |
| Tags | none |
| Tracked files | 525 |
| Tracked build artifacts | none — `dist/`, `coverage/`, `*.tsbuildinfo` and `.DS_Store` are correctly ignored |

`git` on this machine is the Xcode-shimmed binary and refuses to run until the
Xcode licence is accepted. All git in this pass ran through
`/Library/Developer/CommandLineTools/usr/bin/git` with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`.

## Dirty worktree at the start

23 modified tracked files and 14 untracked paths, almost all of them the
in-progress Automation module.

**Modified**

```
apps/api/src/api.module.ts
apps/api/src/workers/worker-roles.ts
apps/web/src/app.ts
apps/web/src/live/ability.ts
apps/web/src/live/dispatch.ts
apps/web/src/live/store.ts
apps/web/src/router.ts
apps/web/src/state.ts
apps/web/src/styles/screens.css
apps/web/src/styles/tokens.css
apps/web/src/ui/shell.ts
docs/AUTOMATION_ENGINE.md
docs/PRODUCT_AUDIT.md
docs/api/openapi.v1.json
docs/api/operation-inventory.md
docs/execution/current-task.md
packages/domain/src/iam/permissions.ts
packages/domain/src/iam/roles.test.ts
packages/domain/src/index.test.ts
packages/domain/src/index.ts
tests/integration/api-contract.test.ts
tests/integration/cli-process.test.ts
tests/integration/migrate.test.ts
tests/integration/permission-catalogue.test.ts
```

**Untracked**

```
apps/api/src/automations/
apps/web/src/api/automations.ts(+test)
apps/web/src/live/automation-actions.ts(+test)
apps/web/src/ui/automations-screen.ts(+test)
docs/meeting/
output/
packages/database/migrations/0028_automation_foundation.sql
packages/database/migrations/0029_automation_event_queue.sql
packages/domain/src/automations/
tests/integration/api-automations.test.ts
```

`output/` is a generated PDF directory that is untracked and should stay
untracked; it is not part of the product.

## Toolchain

| Tool | Version |
| --- | --- |
| Node | v22.23.2 (`engines: >=22 <23`) |
| pnpm | 9.12.0 (`packageManager` pinned) |
| TypeScript | 5.6.3 |
| NestJS | 11.2.3 |
| Fastify | 5.12.3 (pnpm override pins it) |
| PostgreSQL (tests) | embedded-postgres 17.4.0-beta.15 |
| Vitest | 2.1.2 · Playwright 1.55.0 |

## Repository topology

```
apps/api        119 files   21,129 LOC   NestJS + Fastify, 8 process roles in one artifact
apps/web         91 files   29,630 LOC   Vite, hand-written TS, no UI framework
apps/proposal                            static sales-collateral server (not the product)
packages/contracts 8 files     314 LOC
packages/domain   53 files  10,337 LOC   pure domain, no driver imports
packages/database 42 files   5,597 LOC   migrations 0001→0029 + runner + RLS context
tests            116 files  16,778 LOC   unit / integration / property / e2e
```

## Deployment topology as actually deployed (Railway)

| Service | Exposure | Role |
| --- | --- | --- |
| `convo-client-demo` | **Public** | static web + same-origin `/api` reverse proxy |
| `convo-api` | private | `CONVO_PROCESS_ROLE=api` |
| `convo-worker-inbound` | private | normalization, lifecycle wakes, receipts |
| `convo-worker-interactive` | private | interactive outbound dispatch |
| `convo-worker-campaign` | private | campaign dispatch |
| `convo-worker-report` | private | campaign CSV exports |
| `Postgres` | private | persistent volume |
| `convo-database` | one-shot | bootstrap + forward-only migrations |

`worker-integration` exists in source as a process role but **is not deployed**.
`realtime` and `ingress` roles exist in source and are also not deployed as
separate services; the `api` role serves those routes today.

## Baseline gates measured before any change

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (4 project graphs) |
| `pnpm test:unit` | pass — 89 files, **1608 tests** |
| `pnpm test:integration` | pass — 25 files, **518 tests** |
| `pnpm test:load:target` | **blocked** — script is `exit 1`, no k6, no staging |
| `pnpm test:recovery` | **blocked** — script is `exit 1`, no restore target |

## Known risks carried in from the start

1. Invitation and password-recovery email are `LoggingRecoveryDelivery` /
   `LoggingInvitationDelivery`. They log and send nothing. Bound by default in
   `ApiModule.register`, and `startApi` passes no adapters, so this is what
   production runs.
2. `unconfiguredTransport` is the bound channel transport. Every outbound send
   is refused `provider_not_connected`. No live messaging exists.
3. `unconfiguredBroker` is the bound broker. `worker-integration` fails closed
   on it — and automation schedule materialization was added to that worker's
   tick, so scheduling cannot run in the deployed topology at all.
4. No `/live` or `/ready` endpoint exists on any API or worker role.
5. No CSP, HSTS, `frame-ancestors` or `Permissions-Policy` anywhere.
6. Fastify has no `trustProxy`, but every browser request arrives through the
   web reverse proxy, so `request.ip` is the proxy for every user.
7. Observability is `console.log`/`console.error` in `main.ts` only.
8. The automation module writes `automation_runs` rows and nothing ever
   executes them; `automation_recipients` and `automation_logs` have no writer.
