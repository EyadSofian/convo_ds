# Current coverage gap register

This is a temporary engineering register for the existing 100% V8 gate. It is
not a justification for lowering thresholds or adding broad exclusions.

Snapshot from `pnpm test:coverage` on 2026-09-22 (2,585 tests):

| Metric | Covered | Total | Result |
| --- | ---: | ---: | --- |
| Lines/statements | 27,800 | 28,504 | 97.53% (gate: 100%) |
| Functions | 2,046 | 2,120 | 96.50% (gate: 100%) |
| Branches | 9,729 | 10,079 | 96.52% (gate: 100%) |

The report/lifecycle/team services are covered for normal, empty, unknown actor,
scope and filter paths. The remaining report parser entity checks are covered
by feature-local tests; the full suite must be rerun after this register is
updated. No exclusion was added for changed reporting code.

## Gap register

The line/function/branch locations below are taken from
`coverage/coverage-final.json`. Each row names the behavior that needs a
feature-local test (or a simplification if the branch is provably impossible).

| File | Uncovered lines/functions/branches | Class | Planned evidence |
| --- | --- | :---: | --- |
| `apps/api/src/automations/automation-request.ts` | branches 23,25,31,33-34,38-39,41,47-48 | B | Request parser tests for every malformed cursor/filter/state/sort and valid boundary. |
| `apps/api/src/automations/automation.service.ts` | branches 31,41-42,52,57,64,97-98 | B | Service tests for missing automation, transition conflict, archived/default query and delete races. |
| `apps/api/src/channels/outbound.service.ts` | lines 172-173; branch 171 | B | Provider rejection and unavailable-connection mapping test. |
| `apps/api/src/conversations/conversation.controller.ts` | lines 567-594; `queryError`; branches 82,97,566,572,578,583-584 | B | Controller tests for each invalid query shape and translated database error. |
| `apps/api/src/conversations/conversation.service.ts` | lines 485-486,699-707; `requireSupervisor`, `cursorPredicate`; branches 367,373,409,418,421,468,693-695 | A/B | Supervisor permission failures and each cursor sort/filter boundary. |
| `apps/api/src/conversations/inbox-query-compiler.ts` | lines 76-79,98-102,107-108,125-138,157-158; helpers `many`, `datePredicate`, `comparison`; branches 47-166 | A/B | Compiler matrix covering empty/multi values, every date operator, custom field type and keyset comparison. |
| `apps/api/src/conversations/inbox-query-request.ts` | lines 51-65; `customValue`, `validDate`; branches 14-67 | B | Request validation matrix for null, invalid date, custom values and unsupported operators. |
| `apps/api/src/conversations/inbox-query-validation.ts` | lines 21-33,44-64; helpers `validCustomFilter`, `isDate`, `invalidQuery`; branches 20,36,41 | B | Validation tests for every custom field type, date, enum and malformed query. |
| `apps/api/src/conversations/supervisor-directory.ts` | branch 41 | A | Archived/inactive team and membership directory visibility regression. |
| `apps/web/src/actions.ts` | lines 235-238; `analyticsView` | C | URL parser tests for all report views and backward-compatible operations alias. |
| `apps/web/src/app.ts` | line 718; branches 717,719 | C | App shell render with report deep link and missing route state. |
| `apps/web/src/prepaint-language.ts` | branch 21 | C | Persisted Arabic, persisted English and invalid language prepaint test. |
| `apps/web/src/state.ts` | lines 289-323; `isUuid`; branches 286-317 | A/C | State reducer tests for report filters, UUID agent identity, malformed deep links and reset. |
| `apps/web/src/api/automations.ts` | lines 118-119; `deleteDraft`; branch 128 | B | Delete success/error response and query-preserving mutation test. |
| `apps/web/src/api/campaigns.ts` | branches 320,325,330 | B | Campaign attribution drill-down API error and empty envelope cases. |
| `apps/web/src/api/conversations.ts` | lines 194-210; supervisor API helpers; branches 184-190 | B | Supervisor endpoint success, 403, 404 and malformed response tests. |
| `apps/web/src/api/metadata.ts` | lines 63-68 | B | Label update/retire success and server error mapping. |
| `apps/web/src/api/saved-views.ts` | lines 34-43 | B | Saved-view create/update/retire API success/error cases. |
| `apps/web/src/live/actions.ts` | branch 166 | C | Stale request generation ignored after newer report filter request. |
| `apps/web/src/live/automation-actions.ts` | lines 55-59,96-100,226-233; `setAutomationRunsQuery`; branches 41,49,54,71,218,225,231,273,277-278 | A/C | Paging append, cursor reset, state/sort/search combinations, load error and empty runs. |
| `apps/web/src/live/campaign-actions.ts` | lines 120-121; branches 65,90,100,105-170 | A/C | Campaign report load, drill-down, stale response and failure state. |
| `apps/web/src/live/dispatch.ts` | lines 203-220,513-526,683-703,739-786,1009-1044,1289-1350; listed dispatch handlers; branches 383,386,758,1311-1341 | A/B/C | Handler-level tests for automation confirmation/paging, supervisor lifecycle, saved views, labels, debounce and custom-field operators. |
| `apps/web/src/live/inbox-actions.ts` | lines 49-66,93-126,158-164,481-517; supervisor loaders/workload; branches 48,51,77-89,152,157-165,480,482 | A/C | Supervisor open/exit, load error, no agents, workload refresh and stale reload. |
| `apps/web/src/live/inbox-lists.ts` | line 27; branch 26 | C | Empty list and non-empty list state rendering. |
| `apps/web/src/live/inbox-query.ts` | branches 9,13,19,38 | A | Canonical serialization for every drill-down filter and omitted defaults. |
| `apps/web/src/live/metadata-actions.ts` | lines 30-87 | A/C | Inline create+assign, update, retire confirmation, server failure and duplicate response. |
| `apps/web/src/live/saved-view-actions.ts` | lines 8-114; `t`, apply/save/retire/isVisibility; branch 14 | A/C | Private/team/workspace permissions, apply, update, retire and empty server list. |
| `apps/web/src/ui/analytics-screen.ts` | lines 168,185-192,221,230,286-287,295,297,301,303,318,424; `renderChannels`; branches 54-516 | C | Dedicated report screens in loading/error/empty/populated states, unattributed rows, RTL and mobile overflow. |
| `apps/web/src/ui/automations-screen.ts` | branches 106,247 | C | Archived exclusion and run pagination empty state. |
| `apps/web/src/ui/dialogs.ts` | lines 44-148; dialog helpers; branches 31-102 | C | Automation delete, label retire, saved-view dialog cancel/confirm and validation states. |
| `apps/web/src/ui/live-inbox.ts` | lines 152,238-429,451,458-481; helper functions; branches 118-712 | C | Supervisor read-only controls, custom-field controls, saved views, labels, empty/loading/error and responsive rendering. |
| `apps/web/src/ui/metadata-section.ts` | lines 79,89; branches 78,88,95 | C | Label color/retired historical rendering and missing metadata. |
| `apps/web/src/ui/settings-screen.ts` | lines 62-80; `labelsPanel`; branch 54 | C | Label palette, HEX validation, empty/error/loading settings states. |
| `packages/domain/src/conversations/inbox-query.ts` | line 41; branches 27-44 | A | Domain query normalization for each optional filter and sort. |
| `packages/domain/src/conversations/inbox-saved-view.ts` | branches 22,32,38,43-45,60,68-78 | A/B | Visibility and saved-view validation across private/team/workspace and malformed filters. |

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
