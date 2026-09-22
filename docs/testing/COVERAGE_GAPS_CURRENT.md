# Current coverage gap register

This is a temporary engineering register for the existing 100% V8 gate. It is
not a justification for lowering thresholds or adding broad exclusions.

Snapshot from the latest `pnpm test:coverage` on 2026-09-22 (all unit,
integration and property files passed):

| Metric | Covered | Total | Result |
| --- | ---: | ---: | --- |
| Lines/statements | 27,917 | 28,501 | 97.95% (gate: 100%) |
| Functions | 2,066 | 2,119 | 97.49% (gate: 100%) |
| Branches | 10,029 | 10,287 | 97.49% (gate: 100%) |

The report/lifecycle/team services, the covered API validation boundaries, and
the new supervisor/reporting correctness paths are covered. The remaining gaps
are in pre-existing inbox, automation and UI boundary paths; no exclusion was
added for changed reporting code.

## Gap register

The locations below are regenerated from `coverage/coverage-final.json` for this
snapshot; rows are removed when a file becomes fully covered.

| File | Uncovered lines | Uncovered functions | Uncovered branches |
| --- | --- | --- | --- |
| `apps/api/src/conversations/conversation.controller.ts` | — | — | 82 |
| `apps/api/src/conversations/conversation.service.ts` | — | — | 373, 409, 468 |
| `apps/api/src/conversations/inbox-query-compiler.ts` | 78-79, 101-102, 107-108, 125-126 | — | 52, 58, 65, 77, 83, 100, 106, 111, 114, 118-119, 123-124, 130-132, 135 |
| `apps/api/src/conversations/inbox-query-request.ts` | 54-56, 59-60 | — | 19, 25-26, 28, 39, 43, 46, 49, 53, 58, 63 |
| `apps/api/src/conversations/inbox-query-validation.ts` | — | — | 25, 29, 36, 47-48, 57 |
| `apps/web/src/actions.ts` | 235-238 | `analyticsView@234` | — |
| `apps/web/src/app.ts` | 718 | — | 717, 719 |
| `apps/web/src/prepaint-language.ts` | — | — | 21 |
| `apps/web/src/state.ts` | 289-290, 307, 309-310, 318, 321-323 | `isUuid@321` | 286, 288, 299, 301, 306, 308, 313-317 |
| `apps/web/src/api/metadata.ts` | 63-64, 67-68 | `updateLabel@62`, `retireLabel@66` | — |
| `apps/web/src/api/saved-views.ts` | 34-35, 38-39, 42-43 | `create@33`, `update@37`, `retire@41` | — |
| `apps/web/src/live/actions.ts` | — | — | 166 |
| `apps/web/src/live/automation-actions.ts` | 55-59, 96-100, 226-229, 232-233 | `setAutomationRunsQuery@96` | 41, 49, 54, 71, 218, 225, 231, 273, 277-278 |
| `apps/web/src/live/campaign-actions.ts` | 120-121 | — | 65, 90, 100, 105-106, 109, 119, 132-133, 145-146, 151, 158, 164, 170 |
| `apps/web/src/live/dispatch.ts` | 203-205, 207-209, 211-220, 513-516, 518-522, 525-526, 683-692, 694-696, 700-703, 739-741, 748-754, 766-772, 775-779, 782-786, 1009-1014, 1017-1024, 1027-1031, 1034-1044, 1289, 1292-1304, 1315-1319, 1323-1328, 1332, 1334, 1345-1350 | `asAutomationState@203`, `asAutomationSort@207`, `validLabelColor@211`, plus dispatch handlers at 512-1350 | 383, 386, 758, 1311, 1314, 1320, 1322, 1330-1331, 1333, 1336, 1341 |
| `apps/web/src/live/inbox-actions.ts` | 49-50, 52-66, 93-102, 105-126, 158-164, 481, 483-484, 508-517 | `loadSupervisorAgents@93`, `loadSupervisorInbox@105`, `refreshSupervisorWorkload@508` | 48, 51, 77-78, 89, 152, 157-158, 165, 480, 482 |
| `apps/web/src/live/inbox-lists.ts` | 27 | — | 26 |
| `apps/web/src/live/inbox-query.ts` | — | — | 9, 13, 19, 38 |
| `apps/web/src/live/metadata-actions.ts` | 30-56, 58-67, 69-77, 79-87 | `createAndAssignLabel@30`, `updateLabel@69`, `retireLabel@79` | — |
| `apps/web/src/live/saved-view-actions.ts` | 8-10, 22-40, 42-66, 68-88, 90-110, 112-114 | `t@8`, `applySavedView@22`, `saveCurrentInboxView@42`, `retireSavedView@90`, `isVisibility@112` | 14 |
| `apps/web/src/ui/analytics-screen.ts` | 168, 286-287, 295, 297, 301, 303, 318, 424 | — | 86-87, 89-90, 111, 113, 121-122, 124-125, 128, 158, 167, 187, 189-191, 255, 259-260, 274, 276, 278, 284-285, 291, 294, 296, 300, 302, 312-313, 315-317, 319, 329, 331, 333, 340, 344, 423, 449, 451, 502, 511, 516 |
| `apps/web/src/ui/automations-screen.ts` | — | — | 106, 247 |
| `apps/web/src/ui/dialogs.ts` | 44-57, 59-71, 113-148 | `automationDelete@44`, `workspaceLabel@59`, `savedInboxView@113` | 31-32, 35, 88, 93, 102 |
| `apps/web/src/ui/live-inbox.ts` | 152, 238-244, 253, 264-265, 280-285, 297, 347-355, 360-363, 366-368, 370-377, 385, 387-399, 404-421, 425-429, 451, 458-459, 468, 470-481 | `supervisorMetric@280`, `row@345`, `customFieldOperators@360`, `customFieldValueControl@370`, `pickerOptions@404`, `pendingValue@468`, `savedViewsMenu@470` | 118, 151, 201, 203, 237, 252, 254-258, 262-264, 268-271, 294-296, 299, 301, 309, 311, 313, 326, 342, 346, 383-384, 386, 400, 424, 436, 442, 447-448, 450, 453, 457, 460-463, 688, 712 |
| `apps/web/src/ui/metadata-section.ts` | 79, 89 | — | 78, 88, 95 |
| `apps/web/src/ui/settings-screen.ts` | 62-80 | `labelsPanel@62` | 54 |
| `packages/domain/src/conversations/inbox-saved-view.ts` | — | — | 22, 32, 38, 43-45, 60, 68-69, 72, 74, 76-78 |

## Classification and policy

- **A** means real product behavior: add a focused feature or integration test.
- **B** means a defensive/error path: exercise the real boundary with a
  malformed request, provider/database error, or authorization failure.
- **C** means a rendered loading/error/empty/responsive branch: add a UI unit or
  browser assertion.
- No current gap is being classified as an exclusion. If a branch is proven
  unreachable, simplify the implementation and retain a test for the resulting
  behavior; do not add an undocumented ignore marker.

## Completion rule

The milestone is not coverage-complete until a fresh `pnpm test:coverage`
reports 100% lines, statements, functions and branches. Thresholds and the
existing process-entry exclusions remain unchanged.
