# Post-deploy smoke checklist

Use after deploying an immutable tag. Keep request/provider IDs in the private
release record; never put credentials or tokens in this repository.

## Platform and schema

- [ ] Every deployment resolves to the release SHA/tag.
- [ ] Migration service succeeds once; 32 migration rows end at 0032.
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
