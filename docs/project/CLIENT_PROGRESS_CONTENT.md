# CONVO — client progress content contract

Audience: project client. This file and `apps/progress/*` are public-safe. The detailed technical review is in the **local-only** `PROJECT_STATUS_INTERNAL.md` and must never be published from this public repository.

## Page message

- Identity: **CONVO · Project Progress**
- Plan label: **Project Delivery Plan** with three major phases.
- Current phase: the first phase with incomplete tasks, currently **Phase 1 of 3**. This is derived from task state, not an asserted historical date.
- Delivery statement: launch follows verified channels, client acceptance and final production checks. No calendar delivery date is asserted.
- The portal is a read-only status view, not an administration or credential-upload page.

## Status language

| Data status | Client label | Meaning |
| --- | --- | --- |
| `completed` | Completed | The stated deliverable task has evidence of an implemented and tested flow. |
| `in_progress` | In progress | Active review or acceptance work remains. |
| `upcoming` | Upcoming | Planned but not yet accepted/delivered. |
| `blocked` | Waiting for client | Needs approved account access, a business definition or another explicit input before validation. |

Live WhatsApp and real email delivery are **not** called complete. The client is asked for approved account access through an agreed secure channel, never to paste credentials into this portal. The page does not surface security findings, infrastructure incidents, private IDs, Git revisions or internal comments.

## Sections and derivation

The page renders one central source: `apps/progress/progress-data.js`. Its 36 existing tasks and their statuses remain unchanged. The 12-stage source structure and separate internal plan are retained as planning history, but are not displayed to clients. `PROJECT_PHASES` groups every task exactly once; `apps/progress/progress-model.js` computes counts and phase states. No numeric progress value is scattered through page markup.

1. Header and project status: overall completion, current phase, completed and remaining tasks.
2. Three large phase cards: task-derived progress, status and four to six representative items each.
3. Genuinely active work.
4. Required From You: four Meta/channel prerequisites, with explicit Pending/Received/Verified states. Other known launch inputs are mentioned briefly; no password collection.
5. At most five next steps and a concise final deliverables list.

Formula: `overall = round(100 × completed MVP delivery tasks / all MVP delivery tasks)`. Every task currently has equal weight. `remaining = total − completed`, so it includes active, upcoming and waiting-for-client work. Each phase uses the same formula for its assigned tasks. A phase is Completed only if all its tasks are complete; otherwise In Progress takes precedence when work is active, then Waiting for Client when blocked, otherwise Upcoming. The plan intentionally excludes optional post-MVP work from the denominator.

## Safe update checklist

1. Verify changed status against current code, tests and operational evidence.
2. Confirm that a live provider step has **real** inbound/outbound or email proof, not only a scripted test.
3. Update task and individual requirement states in `apps/progress/progress-data.js` only with evidence. One access item can be verified while other items still block the linked task; do not alter the grouping to improve the percentage.
4. Run `pnpm test:progress`, `pnpm lint` and the portal browser checks at 390, 430, 768, 1366 and 1440px.
5. Review client wording for secrets/private incidents, then republish the separate static site.
6. If scope or schedule changes, update this plan and obtain client approval before presenting a new delivery promise.

## Hosting boundary

The portal is live at **https://eyadsofian.github.io/convo_ds/** through GitHub Pages. Access is public/read-only with no login or share token; the published artifact contains only the five client-safe static page files, not this repository's internal documentation. The source remains under `apps/progress`, separate from the CONVO runtime. Hosting it does not activate or redeploy customer messaging.

After each approved data update, publish only `index.html`, `styles.css`, `app.js`, `progress-data.js`, and `progress-model.js` to the `gh-pages` branch without force-pushing. Verify the live page, counts, phone layout and client-safe wording before sharing the refreshed URL. A private access requirement would need a different host with server-side authorization; a URL token on public static hosting is not access control.
