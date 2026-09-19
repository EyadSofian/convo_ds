# CONVO visual audit

Audit date: 2026-09-19

Baseline: `eac8b262c5b6eadf3289327ce1bbabd40249a7dc`
Surfaces reviewed: production sign-in plus the scripted, production-built workspace in Arabic/RTL and English/LTR, light and dark.

## Audit method

The production URL was captured at 1440×900. The clean source was then built before running the visual suite so stale `dist` output could not masquerade as evidence. The scripted API was used only to expose UI states; it does not claim provider or backend success. Existing screenshots, DOM-structure snapshots, keyboard paths, empty/denied/offline states, dialog states, and responsive layouts were reviewed.

Severity uses P1 for an operational blocker, P2 for a material usability or consistency problem, and P3 for polish.

## Public authentication

### Login

- SCREEN: Login.
- ISSUES: the central card is visually undersized on wide displays; the canvas has no spatial anchor; the brand, introduction, fields, and submit action are too similar in visual weight.
- SEVERITY: P2.
- VISUAL CAUSE: narrow 400px card, moderate padding, low surface separation, and an undifferentiated vertical rhythm.
- UX IMPACT: the first production touchpoint feels more like a utility form than a trusted operations product.
- FIX PLAN: strengthen the auth surface, increase deliberate whitespace inside the card, preserve compact mobile behavior, and keep language/theme controls visually secondary.

### Forgot password / recovery request

- SCREEN: `#/reset-password` without a token.
- ISSUES: inherits the login hierarchy problem; error/help copy can visually merge with field metadata.
- SEVERITY: P2.
- VISUAL CAUSE: shared auth shell and small metadata spacing.
- UX IMPACT: recovery intent and next action are slower to scan.
- FIX PLAN: use the refined auth shell and consistent notice, help, and field spacing.

### Reset password

- SCREEN: `#/reset-password?token=…`.
- ISSUES: two password fields, rule text, and action lack clear grouping; invalid-link state is visually close to ordinary inline feedback.
- SEVERITY: P2.
- VISUAL CAUSE: shared single-column rhythm without a distinct status hierarchy.
- UX IMPACT: users can miss whether they are editing credentials or looking at an expired-link result.
- FIX PLAN: retain the secure flow, improve content grouping, and reinforce notice/error contrast.

### Accept invitation

- SCREEN: `#/accept-invitation?token=…`.
- ISSUES: the invitation purpose is not visually differentiated from password recovery.
- SEVERITY: P3.
- VISUAL CAUSE: identical card treatment.
- UX IMPACT: low; copy is correct but the task context is not immediately prominent.
- FIX PLAN: refine the common shell and title hierarchy without inventing new product behavior.

## Core workspace

### Inbox

- SCREEN: Inbox queue + active conversation + customer panel.
- ISSUES: selected queue row is quiet; dense toolbars compete with the conversation title; separators create a flat “spreadsheet across three panels” effect; the right panel has limited scan hierarchy; queue identity, metadata, and claim action are close in weight.
- SEVERITY: P1 for the visual sprint because Inbox is the primary operator surface.
- VISUAL CAUSE: near-identical surfaces, 52–56px headers, weak elevation, small control geometry, and repeated hairlines.
- UX IMPACT: slower queue scanning and more effort to locate the current conversation, primary lifecycle action, or customer context.
- FIX PLAN: strengthen selected/current states, align panel headers, standardize control geometry, tune column widths, improve message grouping and composer focus, and use section rhythm rather than card proliferation.

### Conversation

- SCREEN: active thread.
- ISSUES: customer and agent bubbles are distinguishable but message metadata is cramped; header actions compress early; short messages still sit in relatively heavy bordered containers.
- SEVERITY: P2.
- VISUAL CAUSE: narrow gaps, border-led differentiation, and toolbar-first header compression.
- UX IMPACT: reduced reading rhythm during long operator sessions.
- FIX PLAN: improve vertical grouping, soften inbound boundaries, keep outbound and private-note semantics distinct, and preserve bidirectional plaintext behavior.

### Customer panel

- SCREEN: details/context panel.
- ISSUES: section labels are low emphasis; fields, labels, consent, routing, notes, and history use similar spacing; controls can feel attached to data rather than to their section.
- SEVERITY: P2.
- VISUAL CAUSE: uniform 16px section padding and repeated subtle dividers.
- UX IMPACT: operators need more scanning to find identity, routing, consent, and history.
- FIX PLAN: strengthen section headings, tune section spacing, preserve progressive disclosure, and keep data rows compact.

### Contacts

- SCREEN: Contacts.
- ISSUES: search/filter tools and results use similar visual priority; table header is easy to lose against the panel.
- SEVERITY: P2.
- VISUAL CAUSE: flat panel/header surfaces and equal-height controls without a stronger toolbar container.
- UX IMPACT: slower transition from filtering to scanning results.
- FIX PLAN: refine toolbar, table header, row hover/current states, and narrow-width overflow.

### People

- SCREEN: People; includes membership administration.
- ISSUES: KPI strip, member table, invitation state, teams editor, and roles editor form many equal-weight rectangles; lower editors become visually busy.
- SEVERITY: P2.
- VISUAL CAUSE: repeated bordered panels and insufficient hierarchy between summary, primary table, and configuration editors.
- UX IMPACT: administrative tasks feel more complex than they are.
- FIX PLAN: improve panel hierarchy, compact editor rows, and keep destructive/secondary actions distinct.

### Teams

- SCREEN: Teams section inside People (not a standalone route).
- ISSUES: create controls and existing team details compete in one panel.
- SEVERITY: P2.
- VISUAL CAUSE: form and collection share the same weight and spacing.
- UX IMPACT: it is harder to distinguish creation from maintenance.
- FIX PLAN: strengthen internal section grouping and consistent inline-form alignment.

### Roles

- SCREEN: Roles section inside People (not a standalone route).
- ISSUES: permission controls are dense and require careful baseline alignment.
- SEVERITY: P2.
- VISUAL CAUSE: compact controls with many labels and states.
- UX IMPACT: increases the chance of selecting the wrong permission during fast administration.
- FIX PLAN: improve label/control alignment, row rhythm, focus states, and narrow-screen stacking.

### Channels

- SCREEN: Channels and connection details/dialog.
- ISSUES: six provider cards use large equal rectangles even when little data exists; provider color, status, capabilities, metrics, and actions compete.
- SEVERITY: P2.
- VISUAL CAUSE: card-per-provider layout and equal visual emphasis.
- UX IMPACT: readiness and required action are not the first things seen.
- FIX PLAN: keep provider identity, elevate connection status/next action, soften secondary capability chips, and standardize card/action alignment.

### Routing

- SCREEN: Routing controls in the customer panel (not a standalone route).
- ISSUES: current assignment, priority, collaborator, and offer controls are tightly grouped.
- SEVERITY: P2.
- VISUAL CAUSE: several compact action groups within one narrow column.
- UX IMPACT: assignment state can be mistaken for an available action.
- FIX PLAN: separate current state from mutation controls and preserve semantic action color.

### Saved views

- SCREEN: Inbox queue tabs/filters; no standalone saved-view management route exists.
- ISSUES: queue counts and filters are compact but the selected queue relies heavily on fill color.
- SEVERITY: P2.
- VISUAL CAUSE: segmented treatment with weak non-color cue.
- UX IMPACT: selection is less obvious in low contrast or rapid scanning.
- FIX PLAN: reinforce selection with weight and boundary in addition to color.

### Campaigns

- SCREEN: Campaigns (`broadcasts` route).
- ISSUES: KPI strip, campaign table, and selected campaign detail compete; lifecycle steps are small; action toolbar is visually distributed.
- SEVERITY: P2.
- VISUAL CAUSE: several information bands with equal borders and weak surface hierarchy.
- UX IMPACT: difficult to identify the current campaign state and next safe action quickly.
- FIX PLAN: strengthen selected row, lifecycle/current step, and action grouping while preserving all safeguards.

### Audiences

- SCREEN: Audience selection and exclusion information inside campaign flows; no standalone route.
- ISSUES: denominator/exclusion information reads as secondary metadata despite being decision-critical.
- SEVERITY: P2.
- VISUAL CAUSE: audience facts use the same type/spacing as ordinary metadata.
- UX IMPACT: an operator can overlook exclusions before launch.
- FIX PLAN: elevate audience counts and exclusion notices through the shared KPI/notice system.

### Automations

- SCREEN: Automations library and builder.
- ISSUES: template cards, builder rail, canvas, and inspector already adapt, but one-line breakpoint rules hide the responsive intent; tabs can become crowded; inspector hierarchy is shallow.
- SEVERITY: P2.
- VISUAL CAUSE: dense three-region builder and isolated responsive overrides.
- UX IMPACT: medium-width editing is harder to understand and maintain.
- FIX PLAN: normalize breakpoints, inspector spacing, tabs, and action states without changing execution logic.

### Reports

- SCREEN: Reports (`analytics` route).
- ISSUES: filter bar is wide; seven KPI cells are dense at 1366; chart and funnel panels are equally weighted; dates and selects can wrap poorly at intermediate widths.
- SEVERITY: P2.
- VISUAL CAUSE: desktop-first multi-column strip and control-heavy filter row.
- UX IMPACT: reduced scan order and horizontal pressure.
- FIX PLAN: standardize filter control alignment, collapse grids by container width, and retain horizontally legible data tables.

### Settings

- SCREEN: Settings.
- ISSUES: account and preferences are balanced, but session rows and unavailable workspace settings look equally actionable; badges in the unavailable list are visually repetitive.
- SEVERITY: P3.
- VISUAL CAUSE: repeated panel treatment and limited actionable/non-actionable distinction.
- UX IMPACT: users may initially expect unavailable rows to be controls.
- FIX PLAN: clarify unavailable surface treatment and keep session actions prominent.

## Cross-system findings

- Spacing: the source has a sound 4px scale, but several literal 3/5/6/7/9/10/11/15px values remain for geometry. Some are legitimate optical corrections; semantic sizes should cover repeated component dimensions.
- Icons and chevrons: the shared icon renderer is consistent, but native select chevrons and compact toolbar glyphs need verified optical alignment in both directions.
- Typography: IBM Plex Sans Arabic is appropriate and self-hosted. Metadata at 12–13px is readable, but hierarchy between page/panel/section titles is modest.
- Color: colors are centralized and contrast-tested. The issue is hierarchy, not palette proliferation.
- Borders: repeated one-pixel boundaries make large pages flat. Panels, table heads, current rows, and chrome need clearer roles.
- Responsive: navigation and Inbox drawers exist, but the regression matrix does not explicitly exercise all required widths.
- Accessibility: focus, semantics, dialog behavior, and reduced motion have strong coverage. Selected states should add shape/weight cues and mobile targets need explicit verification.

## Scope guard

No database, migration, authentication logic, API contract, RLS/RBAC, worker, queue, provider, campaign execution, automation execution, or Railway configuration is changed by this sprint.
