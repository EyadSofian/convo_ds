# Coverage exclusions — full report
MASTER-PROMPT §13 and [strategy.md](strategy.md) allow exclusions only for generated/vendor code, type declarations and provably unreachable code, **each listed with a reason**. This file is that list. It is exhaustive: the `coverage.exclude` array in [vitest.config.ts](../../vitest.config.ts) contains nothing that is not explained here.

Last measured: 2026-09-08, task P1-T3, `pnpm test:coverage` → exit 0; 34 files and 260 tests.

| Measure | Threshold | Measured |
|---|---|---|
| Lines | 100% | **100%** |
| Statements | 100% | **100%** |
| Functions | 100% | **100%** |
| Branches (overall) | ≥95% | **100%** |
| Branches, critical modules | 100% | **100%** |

Critical-module branch gates are enforced per file, not by hand-inspection, via glob thresholds in `vitest.config.ts`. Today they cover `packages/database/src/context.ts`, `packages/database/src/transaction.ts`, `packages/domain/src/installation/**` and `apps/api/src/idempotency/**`. Consent/window policy, idempotency/outbox, delivery-outcome classification, campaign eligibility/budget/scheduler and handoff ownership join that list as each lands.

## 1. Files excluded from instrumentation

### `packages/database/src/bin.ts` — process entry point

The whole file is:

```ts
process.exitCode = await runCli(process.argv.slice(2), process.env, { … }, productionDeps);
```

One top-level side effect. Importing it inside the test runner would execute the CLI against the runner's own `process.argv` and set the runner's exit code — it cannot be covered in-process without breaking the process doing the covering.

It is **not untested**. [`tests/integration/cli-process.test.ts`](../../tests/integration/cli-process.test.ts) spawns it as a real child process and asserts what an operator actually sees: exit `2` with usage on stderr for a missing or unknown command, exit `2` naming the missing environment variable, exit `1` with an empty stdout when the database is unreachable, and exit `0` with the per-migration output for a real bootstrap-then-migrate run against PostgreSQL. That is stronger evidence than a coverage counter, and it is how the `pg` CommonJS import bug was caught — the built CLI would have thrown `SyntaxError: The requested module 'pg' does not provide an export named 'Client'` at load, which the Vitest transform had been hiding.

All decidable behaviour — argument parsing, environment validation, exit-code selection, message routing to stdout vs stderr — lives in `cli.ts`, which is at **100%** line, function and branch coverage.

### `apps/api/src/main.ts` — API process entry point

This file imports runtime metadata, passes the real `process.env` to `startApi`, writes the safe boot failure to stderr and assigns exit code `1`. Importing it during coverage would start a listener or mutate the test runner's process state.

It is exercised as the built `apps/api/dist/main.js` child process by [`tests/integration/api-boot.test.ts`](../../tests/integration/api-boot.test.ts), which proves invalid configuration exits `1`, writes only the typed safe configuration failure to stderr and writes nothing to stdout. The successful listener, configuration aggregation, installation-mode mismatch, listener failure and cleanup paths are exercised in-process through `startApi`; all of that logic lives in `app.ts` and `config.ts` and measures **100%**.

### `**/*.test.ts` — the tests themselves

Standard. Measuring a suite against itself is meaningless.

## 2. Files reported as `0%` that are not exclusions

`packages/database/src/types.ts` and `packages/domain/src/ports/sql.ts` appear in the report at `0%`. They contain only `interface` and `type` declarations, which erase at compile time: zero executable statements, zero functions, zero branches. They contribute nothing to any total (the `All files` row is 100%). They are deliberately left **in** the include glob so that adding a runtime statement to either one starts being measured immediately.

## 3. Not excluded, though it would have been convenient

- **Test doubles that live in `src/`** — `packages/database/src/testing/fake-pool.ts` and `packages/domain/src/testing/fake-sql.ts` sit inside first-party source and are held to the same 100% gate as everything else. They are not re-exported from either package's public index, and a test asserts that.
- **`withTenant`'s `finally` block.** The v8 provider reported one uncovered branch at the `finally` keyword: with a `return` inside the `try`, control never *falls through* the block, so that path was genuinely unreachable. The fix was to assign to a local and `return` after the block, giving the success path a single exit that flows through `finally`. The connection-release guarantee is unchanged and the branch is now reachable and covered — no `v8 ignore` comment was added, and no threshold was lowered.

## 4. Rules for changing this file

An exclusion is added only together with the reason and the alternative evidence, in the same commit. Lowering a threshold, adding a blanket glob, deleting a test or writing a trivial function to move a number is forbidden by [strategy.md](strategy.md) and is not a judgement call.
