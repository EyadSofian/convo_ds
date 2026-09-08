#!/usr/bin/env node
/**
 * Process entry point. Deliberately holds no logic: everything decidable lives
 * in `runCli`, which is unit tested. See docs/testing/coverage-exclusions.md
 * for why this file -- and only this file -- is outside the coverage gate, and
 * `tests/integration/cli-process.test.ts` for the real exit codes it produces.
 */
import { productionDeps, runCli } from './cli.js';

process.exitCode = await runCli(
  process.argv.slice(2),
  process.env,
  { out: (line) => console.log(line), err: (line) => console.error(line) },
  productionDeps,
);
