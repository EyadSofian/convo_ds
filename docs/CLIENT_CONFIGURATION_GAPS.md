# Client Configuration Gaps

These items require client-owned information or a business decision. They do not justify hard-coded assumptions in the product.

| Priority | Required input | Why it is required | Safe state until supplied |
| --- | --- | --- | --- |
| P0 | Meta Developer App ID and secret, Business Portfolio access, Page ID, Instagram Business Account ID, WhatsApp Business Account ID, Phone Number ID, webhook verify token and long-lived system-user token | Live WhatsApp, Messenger and Instagram send/receive | Provider-live operations remain disabled and report `provider_not_configured` |
| P0 | Public API and webhook URLs plus approved Meta redirect domains | Meta verification and OAuth/configuration | No live webhook registration |
| P0 | Service email choice: SMTP or Resend; sender domain, sender address and credentials | Invitations, activation, verification, recovery and operational alerts | Secure flows remain available but cannot deliver mail |
| P0 | Final production domain, TLS/DNS ownership and Railway environment ownership | Cookies, CORS, redirects and go-live | Staging URL only |
| P1 | Whether agents may see only their teams’ conversations | `access.restrict_conversations_by_team` is unanswered | Use permission scopes; do not grant tenant-wide agent access |
| P1 | Final roles and grants for Telesales, Marketing, Operations, B2B / Partnerships and Academic | The teams are known; their permission boundaries are not | Create teams only after membership mapping; keep role editor configurable |
| P1 | Resolution-time definition: terminal event, reopen treatment, snooze treatment and business-hours clock | `reports.resolution_time` is unanswered | Do not publish a misleading metric |
| P1 | Business hours, holidays, timezone and after-hours policy per team | SLA and escalation clocks | SLA engine disabled |
| P1 | SLA targets and escalation recipients by channel/priority/team | Breach calculation and supervisor intervention | No automatic escalation |
| P1 | Campaign approver roles and whether requesters may approve their own work | Approval policy | Preserve existing separation of duties |
| P1 | Marketing consent sources, proof retention and suppression/import policy | Audience eligibility and compliance | Exclude identities without explicit usable consent |
| P1 | Meta template names, languages, categories and approved component schemas | WhatsApp outbound campaigns | Template sends remain unavailable |
| P2 | TikTok product/API access and exact requested interaction types | TikTok capabilities vary by approved API product | Show as unavailable; custom-channel API remains an alternative |
| P2 | Website Chat allowed origins, install domains and visual preferences | Secure widget installation | No web widget key issued |
| P2 | CRM vendor, API contract, auth method, field mapping and conflict ownership | Later CRM integration | Explicitly deferred by client direction |
| P2 | Data retention, deletion, export and legal-hold periods | Production data lifecycle | Keep records; no destructive retention job |
| P2 | Report export retention and who can download PII | Report permissions and cleanup | Restrict exports to privileged roles |

## Secret handling

Provider tokens, SMTP credentials, signing secrets and encryption keys belong only in Railway secret variables. The UI may collect provider identifiers and initiate a server-side connection test, but it must never return stored secret material to the browser or logs.
