# CONVO — client progress content contract

Audience: project client. This file and `apps/progress/*` are public-safe. The detailed technical review is in the **local-only** `PROJECT_STATUS_INTERNAL.md` and must never be published from this public repository.

## Page message

- Identity: **CONVO · Project Progress**
- Plan label: **12-Day Delivery Plan**
- Current presentation stage: the configurable `CURRENT_PROJECT_DAY`, initially **Day 2 of 12**. This is not a historical development start date.
- Delivery statement: **Target handover: Day 12, subject to required inputs and acceptance. No calendar delivery date has been set.**
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

The page renders one central source: `apps/progress/progress-data.js`. It contains all 12 days, their tasks, categories, current day and deliverables. `apps/progress/progress-model.js` computes counts and states. No task copy or numeric progress value is scattered through page markup.

1. Header and overview: current plan stage, overall completion, completed, in progress and remaining tasks.
2. Twelve-day timeline: all stages; selecting a card reveals that day's task states, outcome and any client-dependent step.
3. Area progress: Core Platform, Inbox, Channels, Campaigns, Automation, Analytics, UI / UX and QA & Deployment.
4. Completed work, genuinely active work and at most four upcoming tasks.
5. Required from client: only blocked tasks with a specific client action.
6. Delivery checklist: each item derives its state from linked task IDs.

Formula: `overall = round(100 × completed MVP delivery tasks / all MVP delivery tasks)`. Every task currently has equal weight. `remaining = total − completed`, so it includes active, upcoming and waiting-for-client work. Per-area percentages use the same formula on that area's tasks. Day and deliverable states are also derived, not manually declared in the page. The plan intentionally excludes optional post-MVP work from the denominator.

## Safe update checklist

1. Verify changed status against current code, tests and operational evidence.
2. Confirm that a live provider step has **real** inbound/outbound or email proof, not only a scripted test.
3. Update only `apps/progress/progress-data.js`; advance `CURRENT_PROJECT_DAY` only when the presented delivery stage changes.
4. Run `pnpm test:progress`, `pnpm lint` and the portal browser checks at 390, 430, 768, 1366 and 1440px.
5. Review client wording for secrets/private incidents, then republish the separate static site.
6. If scope or schedule changes, update this plan and obtain client approval before presenting a new delivery promise.

## Hosting boundary

The portal is live at **https://eyadsofian.github.io/convo_ds/** through GitHub Pages. Access is public/read-only with no login or share token; the published artifact contains only the five client-safe static page files, not this repository's internal documentation. The source remains under `apps/progress`, separate from the CONVO runtime. Hosting it does not activate or redeploy customer messaging.

After each approved data update, publish only `index.html`, `styles.css`, `app.js`, `progress-data.js`, and `progress-model.js` to the `gh-pages` branch without force-pushing. Verify the live page, counts, phone layout and client-safe wording before sharing the refreshed URL. A private access requirement would need a different host with server-side authorization; a URL token on public static hosting is not access control.
