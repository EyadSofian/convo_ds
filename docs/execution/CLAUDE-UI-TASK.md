# Claude Code task — rebuild the CONVO client demo UI

You are the requested UI implementer. The user rejected the current `apps/web` UI as visually dated, with poor colours, too few inbox controls, and unlike the Figma-style reference. Do the work in the current repository. Do not merely review or propose a plan: replace and finish the UI implementation.

## Mandatory Claude skills and directory check

Before design or implementation, invoke and follow these installed Claude Code skills: `/design`, `/design-systems`, `/product-polish`, `/wireframing-prototyping`, and `/web-research`. Use the Skill tool rather than only mentioning them. Run `pwd` and verify the exact working directory is `/Users/eyad/Downloads/convo`. If it is not, change to that directory before reading or writing. Do not create a worktree; edit this project's `apps/web` directly.

## Read first

- `docs/design/design-reference.md` is the binding visual direction and names the public Figma Community reference.
- `docs/api/operation-inventory.md` is the product surface.
- `docs/product/business-rules.md` defines roles, scopes and queue privacy.
- Inspect all current `apps/web` files. Treat them as disposable presentation code.

## Required visual research

Use WebSearch/WebFetch if available to inspect current public product UI references for Respond.io inbox filters, Chatwoot inbox/conversation filters, and the named Figma Community customer-support dashboard. Research information architecture and interaction patterns only; do not copy copyrighted artwork or brand identity. Record the URLs and exact patterns used in `docs/design/ui-research.md`. If a page blocks access, record that and use accessible public screenshots/pages.

## Non-negotiable visual direction

- Light, compact, modern support operations workspace like the observed Figma grammar.
- Slim icon rail (about 56px), a distinct grouped-filter/views column, conversation list, timeline/composer, and collapsible customer detail panel at desktop width.
- Neutral `#F7F8FA` ground, white panels, `#2563EB` product accent, restrained amber only for warnings/highlights. Remove the dark green identity, decorative gradients, rounded KPI-card dashboard look, oversized whitespace, tiny illegible text, and generated-AI visual tropes.
- Use crisp 12–14px body text and accessible contrast. Support Arabic RTL and English LTR. Mixed emails, phones and IDs need directional isolation.
- Use logical CSS properties where practical. Follow the breakpoints in `docs/design/design-reference.md`.
- The screen must feel like an actual daily operator tool at 1440px, not a marketing mockup.

## Inbox requirements

The inbox is the main deliverable. It must visibly support and interact with:

- grouped saved views and inbox/team groups;
- All, Unread, Read, Mine, Unassigned;
- assigned employee multi-select, team/inbox, channel, status, priority, labels, SLA state, date and sort;
- active-filter chips, filter count, clear all, saved custom view, conversation counts;
- realistic conversations with unread marker, assignee avatar/name, channel, status, priority/SLA cue, timestamp;
- conversation switching;
- timeline with public reply and private-note tabs, attachments/macros/emoji, send interaction, assignment, status/resolve, snooze, priority, and channel window state;
- customer panel with allowlisted identity, labels, consent/suppression, attributes, CRM linkage and history;
- explicit loading, empty, offline/stale and permission-denied preview states that can be demonstrated through a small state/story switcher or controls.

Do not leak transcript snippets into an unassigned preview state; reflect that rule in the UI data model and rendering.

## Other client-demo screens

Keep polished working screens for Channels, People/Roles, Broadcasts, Analytics and Settings, but make them share the new visual system. Include forms/drawers/modals that respond to input. Any Meta connection data and campaign statistics are clearly labelled `Demo data` or `Provider not connected`; never show invented provider-live success.

## Engineering and acceptance

- Keep this a self-contained Vite + TypeScript client demo under `apps/web`; you may refactor into modules/components and may add lightweight dependencies when justified.
- Preserve all backend/database work. Do not change API semantics and do not commit.
- Navigation must be deep-linkable by hash or route and browser refresh-safe.
- No console/runtime errors. All buttons that look actionable should produce a meaningful interaction/state.
- Add meaningful unit/DOM tests for filters, unread/read, employee assignment, conversation privacy projection, state variants and navigation.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and the web tests. Do not lower repository test or coverage thresholds. If the global coverage tool would include browser-only code unfairly, solve that through real tests rather than excluding the entire app.
- If screenshot tooling is available, inspect at 1440 and 375 widths and correct obvious layout defects.

At completion, report changed files, research sources, interactions implemented, commands run and any honest limitation. Start now and continue until the rebuilt UI and its checks pass.
