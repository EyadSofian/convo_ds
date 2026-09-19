# Remaining before CONVO handover

Snapshot date: 2026-09-19

## A — Development work

- Operator upload/send for attachments, including storage, scanning, MIME,
  size, retention and download authorization.
- Saved-view management UI and complete composable filter binding.
- Explicit campaign submission metadata and approval queue UX.
- Rich automation run/detail UI and optional approval/test-run workflow.
- General agent/team/operations reporting after KPI definitions are approved.

These are real code/UI gaps. They may be accepted into a later delivery slice,
but they must not be mislabeled as configuration-only.

## B — Internal test work

- Export the final source archive from the final merged SHA, verify its SHA-256
  checksum, and perform one install/build from that archive.
- Deploy one identical final SHA to every internal staging application role and
  rerun the authenticated operator journey with synthetic data.
- Exercise signed website/custom ingress without an external provider; build a
  browser-widget journey only if the widget enters scope.
- Run conservative SSE reconnect and queue/restart checks against the final
  staging deployment.
- Complete an isolated native database restore when the internal hosting account
  grants the missing snapshot/restore permission.
- Use owner-controlled Meta or email assets only if authenticated access is
  actually available and only with controlled test accounts.

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

## D — Client acceptance

- UAT of Inbox, contacts, labels, assignments/handoffs, people/teams/roles,
  campaigns, automation, reports and settings against synthetic data.
- Sign off which section-A development gaps are accepted for this delivery.
- Approve the final roles, team visibility, consent and reporting rules.
- After assets are supplied: accept Resend invite/recovery, WhatsApp inbound and
  reply/receipts, one controlled campaign/automation recipient, and alerts.
- Accept the client-hosted deployment, backup/recovery procedure and operations
  ownership. Provider-live production GO remains separate from source receipt.

## E — Post-MVP / optional scope

- Automatic routing, capacity rules and round-robin assignment.
- Business-hours/SLA/escalation engine after policy input.
- Automatic label rules.
- Recurring campaigns.
- Reviewed contact merge/import workflows.
- CRM/Odoo, Telegram, TikTok and other channel adapters.
- Installable website-chat widget if not accepted as an MVP requirement.

## Handover boundary

The archive may be delivered with sections A–E open only when the delivery
receipt explicitly accepts them. Customer production activation may not proceed
while the provider and alert acceptance gates in section D are open under the
current fail-closed policy.
