# CONVO — Threat model (P0)

Method: STRIDE over the trust boundaries below, cross-checked against OWASP API Security 2023. Each mitigation names the requirement ID that proves it.

## 1. Trust boundaries

```
[Browser] ──1──▶ [api]
[Public API client / SDK] ──2──▶ [api]
[Meta] ──3──▶ [ingress]
[api/workers] ──4──▶ [Meta / Odoo / customer webhook URLs / knowledge URLs]
[Platform operator] ──5──▶ [/platform control plane]
[Tenant A] ──6──▶ [shared Postgres / Redis / S3 / search / broker]  ◀──6── [Tenant B]
[LLM output] ──7──▶ [tools → domain services]
[Restore tooling] ──8──▶ [restored snapshot]
```

## 2. Assets

Customer message content and media; contact PII; **consent and suppression records**; provider credentials and app secrets; API key material; webhook signing secrets; audit events; campaign audiences; idempotency records; backups.

Consent/suppression deserves special mention: losing it is not a privacy inconvenience, it is a regulatory and reputational event, which is why ADR-0014 refuses to auto-resume outbound after a restore.

## 3. STRIDE by boundary

| # | Threat | Vector | Mitigation | Req |
|---|---|---|---|---|
| 1 | **Spoofing** | Session fixation, CSRF, stolen token | HttpOnly secure cookies, CSRF tokens, session inventory + revocation, MFA, rate limits | IAM-02, IAM-05 |
| 1 | **Elevation** | Mass assignment of `role_id`, `tenant_id`, `is_admin`, `billing_status` | Server resolves actor/tenant from authorized resources; privileged fields rejected at the schema | SEC-03, IAM-14 |
| 1 | **Info disclosure** | Guessing another tenant's conversation/contact/export ID | 404-shaped response for unknown-to-caller resources; composite FKs; RLS; scope intersection | SEC-01, TEN-02/03 |
| 1 | **Info disclosure** | Agent reads unassigned transcripts before claiming | Projected queue endpoint + projected socket payload; full read only after claim | IAM-11, IAM-12 |
| 2 | **Elevation** | Developer mints an API key stronger than their own grants | Delegation ceiling; key scopes ⊆ granting actor's grants; role change never widens existing keys | IAM-19, IAM-20 |
| 2 | **Repudiation** | Disputed send/approval | Append-only audit with actor kind/id, request_id, resource version | audit_events, CMP-06 |
| 2 | **DoS** | Unbounded filters, huge page sizes, expensive exports | Max page sizes, bounded filters, safe-AST segments, async export jobs, per-tenant rate limits | API-03, API-09, CT-11 |
| 3 | **Spoofing** | Forged webhook | HMAC over exact raw bytes, constant-time; GET verify token is **not** POST auth; tenant from verified asset only | EVT-01, DEL-02 |
| 3 | **DoS / tampering** | Oversized or poison payloads | Size/content limits before parsing; per-element quarantine; bounded quarantine with retryable failure when full | DEL-01, DEL-06, MODE-08 |
| 4 | **SSRF / rebinding** | Tenant-controlled webhook URL, CRM host, knowledge URL, media URL | Validation at configuration **and** per delivery; DNS pinning; redirect restriction; private-range denial; allowlisted provider endpoints; configured connector for on-prem CRM instead of a global bypass | API-14, MEDIA-01, CRM-*, AI-06 |
| 4 | **Info disclosure** | Secrets leaking into logs, metrics, traces or webhook payloads | Redaction layer; callback tokens stripped from access logs; no secrets in errors | DEP-04, API-04 |
| 5 | **Elevation** | Platform admin silently reading tenant conversations | No membership, no chat grant by default; support access is scoped, reasoned, expiring (≤60 min), MFA-gated, bannered, audited | IAM-17, IAM-18 |
| 6 | **Cross-tenant leak** | Shared cache keys, socket topics, S3 prefixes, search snippets, backups, metric labels, RAG index | Tenant scoping is explicit in each of these, each with its own test | TEN-06..TEN-11 |
| 6 | **Stale authority** | Revoked membership with a live socket or queued job | 30-second revocation target; write/send permits reauthorize immediately; caches and drafts purged | IAM-21, SEC-02 |
| 7 | **Prompt injection → elevation** | Malicious content in a customer message or an ingested document | Tenant/actor/policy supplied by server code; tools are scoped service users; ACL filters applied **before** retrieval reaches the model; no raw SQL/HTTP/code execution; side-effect approvals bound to exact arguments and expiry | AI-09, AI-10, AI-T01 |
| 7 | **Unsafe autonomy** | Bot sends after a human took over | Ownership version rechecked at submission **and** at dispatch; fenced serialized gate | AI-02, OWN-02/03 |
| 8 | **Integrity after restore** | Stale-consent send; blind resend of an accepted message | `recovery_hold` enforced outside the restored snapshot; reconcile or quarantine the uncertain interval; new dispatch epoch invalidates old permits | DR-01, DR-02, DEP-09 |

## 4. Explicitly accepted limitations

- **End-to-end exactly-once delivery through a provider is impossible.** We guarantee exactly-once *internal effects* and surface `outcome_unknown` honestly.
- **An in-flight provider request cannot be recalled.** Takeover shows `handoff_pending`, never a fake cancel.
- **RPO > 0 means data can be lost.** We do not claim otherwise; we hold outbound until the interval is reconciled.
- **Prompt injection cannot be prevented, only contained.** The model's authority is bounded by server-side policy, so a successful injection yields no data and no side effect.
- **A passing security suite is evidence, not proof.** We report "no known exploitable critical/high finding after these checks", never "secure".

## 5. Release security gate

No unresolved exploitable critical or high finding. SAST, dependency, secret and container scans clean or triaged with written justification. SBOM and licence report produced. Dynamic API suite (IDOR, mass assignment, SSRF, resource exhaustion) passing. Accessibility review complete. All of this is currently `not_run` — the suites are specified, not executed.
