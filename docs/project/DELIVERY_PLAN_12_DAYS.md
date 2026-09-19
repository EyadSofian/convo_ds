# CONVO — 12-day delivery plan

This is a **proposed delivery and acceptance sequence from the current project state**. Day 1 and Day 2 are the first two stages presented in this plan, not dates when development began. No calendar start or unconditional delivery date has been agreed. Engineering work may overlap stages; the dashboard's current stage is configured in `apps/progress/progress-data.js` as `CURRENT_PROJECT_DAY`.

The plan tracks demonstrable outcomes, not code-writing chronology. Existing code is counted as delivered only when its intended flow is integrated and appropriately tested. Live provider capabilities require real provider evidence; scripted tests do not satisfy that gate.

| Day | Stage | Intended outcome | Acceptance focus |
| --- | --- | --- | --- |
| 1 | Foundation & access | Secure workspace and customer-data foundation | Architecture, sign-in, users/roles and foundational records reviewed |
| 2 | Conversation operations | Operator can handle a conversation in one workspace | Inbox, contacts, assignment, notes, labels, priority and lifecycle walkthrough |
| 3 | Realtime & teamwork | Team members stay in sync during handoff | Live updates, ownership history and final team visibility accepted |
| 4 | WhatsApp connection | First approved channel exchanges a controlled real message | Account access, signed inbound, reply and delivery states verified |
| 5 | Campaigns & audiences | Safe small-audience campaign trial | Audience exclusions, approval and recipient-level outcomes reviewed |
| 6 | Automation | One-recipient flow runs safely | Trigger, action evidence and outcome checked with a real approved recipient |
| 7 | Email & accounts | Invitations and recovery work through real email | Verified sender, inbox delivery, invitation acceptance and recovery reuse denial |
| 8 | Reporting | Priority operational and campaign measures agreed | KPI definitions, workload/response views and campaign reporting reviewed |
| 9 | Reliability & safety | Launch support and recovery plan tested | Access, alert routing, independent recovery and operating thresholds |
| 10 | Interface finalization | Operator experience accepted across devices/languages | Desktop/phone and Arabic/English review, final visual corrections |
| 11 | QA & client acceptance | Joint end-to-end acceptance checklist passes | Client scenarios, approved test accounts and acceptance findings |
| 12 | Launch & handover | Approved release and operating knowledge transferred | Same-release deployment, final health checks, source/docs and admin walkthrough |

## Scope discipline

The safe pilot requires the core operator flow, first approved live WhatsApp connection, real account email, permission acceptance, monitoring/recovery, production smoke and handover. Campaigns and automation must not send broadly before a controlled live trial. CRM, TikTok/other unapproved channels, AI and automated retention deletion are not silently inserted into this 12-day pilot plan.

The broader phased proposal includes automatic routing, SLA/escalation, operator attachment upload and richer general reporting. Some of those remain incomplete or need business definitions. The owner and client must explicitly agree whether they are Day 12 acceptance criteria or a separately scheduled phase; this plan does not quietly mark them complete or post-MVP.

## External dependencies and schedule risk

- Authorized WhatsApp Business account access, approved test recipient and templates unlock Days 4–6 and the live launch.
- Approved email sending account and verified sender domain unlock Day 7 and account-flow acceptance.
- A named on-call contact/destination unlocks alert delivery and launch monitoring.
- Final roster, team access rules and reporting definitions are needed for Days 3 and 8 acceptance.
- An independent release reviewer and final client acceptance are needed before the protected release can be promoted.

If inputs arrive late, the relevant stage waits; the dashboard records that as “Waiting for client” rather than advancing the date or fabricating completion. Target handover is **Day 12 after the gates pass**, not a guaranteed calendar date.

## Update protocol

The client portal is read-only. The owner edits task statuses and `CURRENT_PROJECT_DAY` in the single source at `apps/progress/progress-data.js`, runs `pnpm test:progress`, reviews the rendered page, then republishes the static portal. Percentages and deliverable states are calculated from task data; do not type in percentages manually. Never add credentials, private incident details, internal IDs or unresolved security findings to the public data source.
