# Post-deploy smoke checklist

Use after deploying an immutable tag. Keep request/provider IDs in the private
release record; never put credentials or tokens in this repository.

## Platform and schema

- [ ] Every deployment resolves to the release SHA/tag.
- [ ] Migration service succeeds once; 33 migration rows end at
      `0033_account_security_events.sql`.
- [ ] Web `/healthz`, API `/live` and `/ready`, and every worker's `/live`,
      `/ready`, and `/metrics` return 200.
- [ ] Railway healthcheck paths and restart policies are explicitly configured.
- [ ] Startup logs contain no secret, token, raw recipient, or unhandled error.

## Authentication and email

- [ ] Login succeeds; bad passwords are limited per client IP, not proxy-wide.
- [ ] Invitation commits its outbox, Resend sends, provider ID persists,
      acceptance creates the right membership, and token reuse fails.
- [ ] Recovery is generic for known/unknown users; reset revokes old sessions;
      old password and token reuse fail.
- [ ] Forced 429, 500, timeout, DNS, and unknown outcomes produce typed,
      observable, bounded retry evidence.

## WhatsApp and automation

- [ ] Template sync imports authorized WABA templates and safely disables a
      remote deletion.
- [ ] Signed inbound, duplicate delivery, outbound provider ID, and
      delivered/read/failed receipts pass with the real provider.
- [ ] An MVP automation plans once, executes ordered steps, survives restart,
      avoids duplicate effects, and exposes typed failure logs.

## Operations

- [ ] Production backup/PITR is enabled and current.
- [ ] Restore to isolation verifies migration count, tenant isolation, login,
      and authenticated reads.
- [ ] Pilot load profile meets approved latency/error thresholds.
- [ ] Alerts reach the named on-call destination.
- [ ] Rollback rehearsal proves the prior image can run on the forward schema,
      or the release is halted.

## 2026-09-18 GitHub-backed staging evidence

All application services were rebuilt from `EyadSofian/convo_ds`, branch
`release/production-hardening`, at immutable commit
`eac8b262c5b6eadf3289327ce1bbabd40249a7dc`. The migration job and API, web,
inbound, interactive, campaign, report, integration and automation services all
completed successfully. Public web `/healthz` and API `/api/v1/instance`
returned 200 after the redeploy.

A fresh synthetic operator was created through the real recovery flow. Tokens
and credentials were held only in process memory and were not written to this
repository or the evidence below. Against the redeployed release, the following
authenticated flow passed:

| Step | Result |
| --- | --- |
| login and session/membership discovery | PASS |
| Inbox list and open conversation | PASS |
| unassign then assign to current operator | PASS |
| internal note | PASS |
| add label metadata | PASS |
| set high priority | PASS |
| second authenticated session | PASS |
| second session receives `conversation.assigned` over SSE | PASS |
| resolve then reopen | PASS |
| note and episode/audit history | PASS |
| logout both sessions | PASS |

The exercised conversation finished open, high priority and assigned, with the
new note and history entries present. Synthetic sessions were explicitly logged
out. No provider success is implied: Resend delivery, Meta inbound/outbound and
alert delivery remain unchecked until real external credentials/destinations
are supplied.
