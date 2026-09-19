# Remaining before CONVO handover

Snapshot date: 2026-09-19

## A — Must fix before source handover

- [x] Merge PRs 1–5 through protected `main` with required CI.
- [x] Verify the merged repository from a fresh clone with frozen install,
  compile, security, coverage and browser gates.
- [x] Publish a truthful completion audit and integration matrix.
- [x] Provide a deployment guide that does not depend on GitHub or Railway.
- [x] Remove documentation claims that contradict the implemented WhatsApp
  transport and describe secrets in a vendor-neutral way.
- [ ] Export the final source archive from the final merged SHA and verify its
  checksum. This is an operator delivery action, not a code gap.

## B — Internal product work after handover

- Operator upload/send for attachments, including storage, scanning, MIME,
  size, retention and download authorization.
- Saved-view management UI and complete composable filter binding.
- Explicit campaign submission metadata and approval queue UX.
- Rich automation run/detail UI and optional approval/test-run workflow.
- General agent/team/operations reporting after KPI definitions are approved.

These items should be individually scoped and tested. They do not justify a
speculative architectural rewrite.

## C — Client input required

- Final production domain, TLS/DNS control and hosting ownership.
- User roster, team membership, final role grants and whether agents are
  restricted to team conversations.
- Business hours, holidays, timezones, SLA targets, pause rules and escalation
  recipients.
- Resolution-time definition and approved operational KPI formulae.
- Marketing consent sources, evidence retention and suppression/import policy.
- Data retention, deletion, export, legal hold and report-download policy.
- Approved Meta assets, Resend sender/account, synthetic test recipients and a
  named alert destination.

## D — Live verification required

- Resend invitation and password-recovery chains, including link reuse denial.
- WhatsApp real signed inbound, agent reply, provider message ID and delivery
  receipts, followed by exactly one controlled automation recipient.
- Messenger/Instagram inbound only if those channels are enabled; do not call
  them two-way until outbound transports exist.
- Website/custom signed ingress from an approved installation when scoped.
- Alert warning and critical paths with a check that payloads contain no secret
  or customer message content.
- Authenticated staging operator smoke on the exact deployment SHA.
- Isolated native database recovery drill when the hosting account grants the
  required snapshot/restore permission.

## E — Post-MVP / optional scope

- Automatic routing, capacity rules and round-robin assignment.
- Business-hours/SLA/escalation engine after policy input.
- Automatic label rules.
- Recurring campaigns.
- Reviewed contact merge/import workflows.
- CRM/Odoo, Telegram, TikTok and other channel adapters.
- Installable website-chat widget if not accepted as an MVP requirement.

## Handover boundary

The archive may be delivered with sections B–E open because they are clearly
classified. Customer production activation may not proceed while the provider
and alert live gates in section D are open under the current fail-closed policy.
