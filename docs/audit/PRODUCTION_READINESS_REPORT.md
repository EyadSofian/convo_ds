# Production readiness report

Audit date: 2026-09-17
Branch: `release/production-hardening`
Starting revision: `2aa0881e4b7221f5a37ec2fcff8ec9bd4e46989a`

## Verdict

**NO-GO for live customer traffic. Core release gates are green; external
production configuration remains blocked.**

The controlled engineering blockers are closed: real mutation testing passes,
PITR and scheduled backups are enabled, a native recovery point boots, health
checks are persisted, the complete operator lifecycle and two-session realtime
replay pass on staging, the production-shape load curve has zero errors, orphan
recovery is bounded, and production worker variable contracts are staged.

External blockers:

1. `BLOCKED_EXTERNAL_CONFIG`: no authorized Meta app/WABA/phone assets or live
   credentials, so real send, receipt and template synchronization cannot run.
2. `BLOCKED_EXTERNAL_CONFIG`: no Resend key and verified sender/domain, so real
   invitation/recovery delivery cannot run.
3. `BLOCKED_EXTERNAL_CONFIG`: no named on-call destination, so alert rules are
   defined but delivery cannot be installed or demonstrated.

The Git remote blocker was closed on 2026-09-18: `main`,
`release/production-hardening` and `v1.0.0-rc.1` all resolve remotely to
`eac8b262c5b6eadf3289327ce1bbabd40249a7dc`.

Production activation remains withheld while the three customer-safety
dependencies above are absent.

## Gate evidence

| Gate | Result |
| --- | --- |
| lint / typecheck / build | PASS |
| unit | PASS — 1,847 tests |
| integration | PASS — 574 tests after bounded orphan-recovery coverage |
| property | PASS — 5 tests |
| contracts | PASS — 170 unit + 123 integration |
| security | PASS — 377 tests; production dependency audit clean |
| coverage | PASS — 100% statements, branches, functions and lines |
| e2e / a11y / visual | PASS — 242 / 40 / 33 tests |
| recovery | PASS — 13 tests plus Railway native snapshot boot |
| load | PASS — 0 errors at 10/25/50/100 staging concurrency |
| mutation | PASS — 83.69%, 564 scored, 470 killed, 2 timed out, 92 reviewed survivors |

Final current-tree rerun evidence and immutable staging deployment identifiers
are recorded in the release manifest after the release cut.

## Staging operational proof

- All nine services deployed and passed configured health probes.
- Signed inbound created a conversation; two independent sessions proved
  assignment, internal note, label, priority, resolve/reopen, audit evidence
  and realtime replay.
- A 200-event burst drained in under three observed seconds: 200 normalized,
  zero quarantined, zero remaining.
- At 100 concurrent operators the mixed curve completed 1,048 requests with
  zero errors (p50 334.0 ms, p95 1,349.8 ms, p99 2,393.2 ms).
- Recommended pilot envelope: 25 simultaneously active operators; two API
  replicas for availability, with the triggers in `ALERTING.md`.

## Production platform state

- PITR enabled and bucket wired; daily/weekly schedules plus an on-demand
  release recovery point exist.
- API, web and the four existing workers have persisted platform health checks.
- `CONVO_TRUSTED_PROXY_HOPS=2` is staged on the production API.
- Integration and automation worker variable contracts and process roles are
  staged. Their release deployment attempts failed closed and are not active.
- **Incident update, 2026-09-18:** connecting the shared Railway services to a
  GitHub source for staging also created production triggers. The production
  migration job unexpectedly succeeded and advanced schema 0025 → 0032; the
  release web deployed, while API and worker deployments failed closed. The
  production API remains unavailable and no customer/provider activation was
  declared. GitHub source triggers were disconnected from all application
  services immediately to prevent another cross-environment deployment. These
  migrations are forward-only and were not rolled back. Future source-driven
  deployment requires environment-isolated Railway services or a workflow that
  targets staging explicitly.

## Deliberate deferrals

- High-growth-table retention automation is deferred for the pilot. Estimated
  growth and mandatory implementation thresholds are in `DATABASE_AUDIT.md`.
- A fully isolated native provider snapshot/application readback remains a
  recovery hardening follow-up; logical isolated restore and native snapshot
  boot are both proven.
