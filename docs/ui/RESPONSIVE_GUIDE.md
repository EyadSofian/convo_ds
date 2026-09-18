# CONVO responsive guide

Responsive behavior is task-based, not “desktop squeezed smaller.” Logical properties support both RTL and LTR.

| Width | Shell | Inbox | Workspace pages |
|---:|---|---|---|
| 1440 | rail or 232px expanded navigation | queue + thread + context panel | full grids, dense tables |
| 1366 | same as 1440 | three columns when screen container permits | full grids with controlled wrapping |
| 1280 | same shell | context becomes a drawer when the thread minimum would be violated | two-column groups begin collapsing |
| 1024 | collapsed rail recommended | queue + thread; context drawer | filters wrap; tables scroll internally |
| 768 | navigation drawer | thread with queue/context drawers | single-column forms and report grids |
| 430 | navigation drawer | one task surface at a time | stacked actions, internal table overflow |
| 390 | navigation drawer | one task surface at a time | minimum supported phone layout |

## Rules

- The document and body never scroll or overflow horizontally. Named page, list, thread, panel, and table regions own scrolling.
- Below 960px the global navigation is an accessible drawer with focus trapping, Escape/backdrop close, and the correct logical side.
- Inbox queue becomes a drawer when the screen container cannot keep both queue and thread usable.
- Customer context becomes a drawer before the thread falls below its minimum width.
- Never compress the three Inbox columns into narrow strips.
- Forms collapse to one column by container width. Buttons wrap as groups, not one label at a time.
- Tables remain real tables; `.tablewrap` owns horizontal scrolling. Do not turn each cell into a pseudo-card.
- On phones, secondary descriptions may truncate, but primary identity, status, and action stay visible.
- Dialogs use viewport-safe max height and 16px minimum outer padding, reduced to 8px only on the narrowest devices if needed.

## QA matrix

At each required width verify Arabic/RTL and English/LTR, light/dark where materially different, global navigation, Inbox queue/thread/context, filters, tables, forms, dialogs, dropdown alignment, focus, empty/error/loading, and document overflow.
