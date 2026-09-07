# CONVO v2 — Specification review

Date: 7 September 2026. Scope: document clarity, internal consistency, traceability instructions and packaging. **This is not a software test report. No application, live Meta integration, server deployment or capacity benchmark was executed as part of this review.**

## Fresh-reader review

An independent reader reviewed MASTER-PROMPT.md and PHASE-PROMPTS.md without the conversation history. It answered six practical questions and checked contradictions. The review used the reader-testing workflow from the doc-coauthoring skill.

| Reader question | Outcome |
|---|---|
| Are SaaS and single-company self-hosted both required? | Yes; same product/schema/artifacts, with distinct single-host and HA operating contracts |
| What do Super Admin, Owner, Agent and service credentials permit? | Separate control-plane/tenant roles, explicit object scopes and credential delegation ceilings |
| What happens if the provider accepts but its response is lost? | outcome_unknown, supported reconciliation or visible uncertainty; no blind retry |
| How do audience snapshots, approvals and campaign cancellation work? | Fixed approved inputs, dispatch-time eligibility, immutable execution and truthful in-flight limits |
| Do missing Meta assets stop all work or count as live success? | Neither; independent work continues and live proof stays blocked |
| How does a smaller-context agent resume? | Indexed master reading, phase cards, requirement IDs and persisted current-task evidence |

## Findings and corrections

| Finding | Correction | Re-review |
|---|---|---|
| Nonzero disaster RPO can lose recent opt-outs/accepted sends, despite a vague preservation requirement | Restore begins with recovery_hold outside restored snapshot; identify uncertain interval, recover/reconcile or quarantine records, invalidate old permits; add DR-02 | Confirmed resolved |
| Agent's Own timeline permission conflicted with scoped unassigned queue visibility | Add conversation.unassigned.preview, allowlisted queue fields and projected endpoint/events; no snippets/transcript/notes/media before authorized claim | Confirmed resolved |
| Running/paused campaign content and execution identity could change implicitly | One immutable execution per campaign ID; post-launch edits rejected; new runs require clone; safe resume/retry stays on same ledger | Confirmed resolved |
| Future scheduling left the meaning of launch ambiguous | POST /launch immediately creates the execution even for future time; scheduled is locked; scheduler activates existing bound revision; edits require cancel + clone | Confirmed resolved in final narrow re-review |

Parent review also added session/notification list routes, a safe assignee directory, explicit clone API and provider privacy/deauthorization callbacks so common screens do not depend on undocumented privileged endpoints.

These findings were fixed in the master and the affected phase cards. No remaining contradiction was identified within the specific re-reviewed contracts. This is not a guarantee that every possible ambiguity has been eliminated.

## Structural verification

The delivery check validates:

- Master section numbering 0–22, phase references P0–P9 and required contract markers.
- Balanced Markdown code fences and parseable fenced JSON examples.
- Local Markdown links resolve within the delivered document tree.
- Archive includes the five v2 Markdown documents and the two referenced prior documents; no environment, repository cache or credentials are included.
- Archive CRC check and per-document SHA-256 manifest.

Exact generated check results are stored in `validation-report.json`. It records document checks only, not the future application's unit/E2E/coverage/load/security results.

## Evidence limits

Current-source review is summarized in RESEARCH-UPDATE.ar.md. The Figma public preview was visually inspected; editable nodes were not accessed. Instagram messaging documentation was directly read in the browser. Several text fetches of other Meta pages returned 429. Actual account grants, tokens, quotas, pricing and live delivery remain implementation-time verification steps.

Technology choices, capacity profiles, coverage thresholds, support-session durations and revocation targets are engineering decisions/proposals. They must be measured/enforced during implementation and cannot be reported as achieved by this document.
