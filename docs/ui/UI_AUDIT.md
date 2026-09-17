# UI audit

## Status of the redesign: NOT PERFORMED

The brief sequenced this work explicitly: *"DO NOT start redesigning UI until
production foundation and critical functionality are safe"*, and *"Aesthetic
polish is NOT allowed to hide a technical blocker."*

The production foundation is **not** yet approved for live customer traffic.
The controlled recovery, load, mutation and automation-execution gates are now
closed, but no email has been sent through an authorized real provider, no
message has been exchanged with authorized Meta assets, and no on-call alert
destination was supplied. Those external dependencies remain more important
than aesthetic changes.

So this pass audited the interface and did not change it. What follows is the
audit; the redesign is scoped work that should start once the gates below it
close.

**One deliberate exception:** the web server's response headers were changed
(CSP, HSTS, `frame-ancestors`, `Permissions-Policy`). That is a security fix
that happens to live in the web tier, not a visual change, and it is covered in
`SECURITY_AUDIT.md` S-4.

## Method and its limits

Audited from source: `apps/web/src` (84 files, ~29,600 lines), the six
stylesheets, `index.html`, and the Playwright layout and visual specs which
assert real geometry at 1440×900 and 1366×768.

**The live deployment at
`https://convo-client-demo-production.up.railway.app/#/inbox` was not opened.**
This environment has no browser access to it. Every observation below is from
source and from the layout assertions, not from looking at the running product.
A redesign should begin by correcting that.

## What exists

Nine screens, hash-routed: Inbox (with a conversation sub-route), Contacts,
Channels, People, Broadcasts, Automations, Analytics, Settings, plus an
unauthenticated Sign-in.

The frontend is **hand-written TypeScript with no UI framework** — direct DOM
construction, a small store, and a dispatch layer. That is a defensible choice
for an operator console and it is why the bundle is small; it also means every
component is bespoke, which is exactly what makes the inconsistencies below
accumulate.

Design tokens already exist (`styles/tokens.css`), there is light/dark theming
decided before first paint, IBM Plex Sans Arabic is self-hosted, and the
document defaults to `lang="ar" dir="rtl"`. The foundations are better than the
brief's "visual quality is unacceptable" implies.

## Findings

### F-1 · Two of the product's own flows have no screen at all — P0 for the redesign

There is **no invitation-acceptance screen and no password-reset screen.**
`apps/web/src/ui/auth.ts` says only *"Your workspace administrator manages
invitations and access recovery."* The API endpoints exist
(`POST /invitations/:token/accept`, `POST /auth/recovery/complete`); nothing in
the browser calls them.

This is the single most consequential UI finding, and this pass made it sharper:
the email service now sends real links to `#/accept-invitation?token=…` and
`#/reset-password?token=…` — routes the SPA does not have. **Those two screens
must be built before the email service can be switched on in production**, or
every invitation lands on the Inbox.

They are scoped in `PRODUCTION_READINESS_REPORT.md` as blocking work, not as
redesign work.

### F-2 · No contact creation anywhere — P1

A contact comes into existence only when a customer messages in. There is no
"add contact" in the API or the UI. For a school importing a student roster,
that is a missing product capability rather than a missing button.

### F-3 · Configuration-required states are needed, not fake data

Channels, Automations and Campaigns are all reachable while unconfigured.
Automations in particular can be built and activated but will never execute, and
any automation with a WhatsApp template step cannot be activated at all
(`whatsapp_templates` is never populated).

The brief's instruction is the right one: *"If a feature requires configuration,
create a professional configuration-required state."* The screens should say
what is missing and link to the setting that supplies it. They must **not**
show sample data — the previous build's demo runtime was removed in commit
`2aa0881` and should stay removed.

### F-4 · The Inbox is not the three-column operator layout the product needs

The current Inbox does not implement the queue / conversation / context split
that this class of product depends on. The conversation should dominate; the
context panel should use progressive disclosure rather than showing every field.
This is the largest piece of the redesign and the one with the highest return.

### F-5 · Message-type distinction is the correctness-critical visual decision

Customer message, agent reply, **private note**, system event and automation
event must be unmistakable at a glance. A private note that reads like a reply
is how an internal comment gets sent to a parent. This is a safety requirement
wearing a visual costume, and it should be specified before any styling.

### F-6 · RTL is declared but unproven beyond layout

`dir="rtl"` is set and the Playwright specs assert geometry in both directions.
Not covered anywhere: chevron and icon mirroring, dropdown and tooltip
placement, drawer and modal slide direction, mixed Arabic/Latin runs, phone
numbers and dates inside RTL text, and table column order. The brief's warning
is exact — `direction: rtl` is the beginning of RTL support, not the end.

### F-7 · Responsive coverage stops at desktop

Two viewports are asserted: 1440 and 1366. Nothing covers 1024, 768, 430 or 390.
For small screens the information architecture has to change — three columns
shrunk to phone width is unreadable, not responsive.

### F-8 · Accessibility is asserted narrowly

`tests/e2e/a11y.spec.ts` runs axe at one viewport. Not covered: keyboard-only
operation of the Inbox, focus trapping in dialogs, focus visibility throughout,
screen-reader names for icon-only controls, contrast across both themes, 200%
zoom, and `prefers-reduced-motion`.

### F-9 · Component consistency

With no framework, each screen builds its own controls. Before any visual work,
the shared set the brief lists — Button, IconButton, Input, Select, Combobox,
Tabs, Badge, Tooltip, Dropdown, Modal, Drawer, Toast, Table, Pagination,
Skeleton, EmptyState, ErrorState, Avatar, ChannelIcon, ConversationStatus —
should be extracted and each screen rebuilt on them. Doing the colours first and
the components later produces a consistent-looking product that is inconsistent
to use.

### F-10 · Empty, loading and error states

Each screen needs all three, and they are currently uneven. An operator seeing a
blank panel cannot tell "still loading" from "nothing here" from "this failed" —
and those need three different reactions.

## Recommended sequence, once the gates close

1. **Build the two missing auth screens** (F-1). Blocking; not redesign.
2. **Audit the live deployment in a browser** at the six required viewports, in
   both directions and both themes.
3. **Extract the component library** (F-9) against the existing tokens.
4. **Redesign the Inbox** (F-4, F-5), including the message-type distinction.
5. **Configuration-required states** (F-3).
6. **RTL and responsive** properly (F-6, F-7).
7. **Accessibility** (F-8), then re-run the a11y gate.
8. **Update visual baselines last**, and only after looking at each screen. The
   brief is right that a changed snapshot is never self-approving.

## Performance to protect

The current build is small and has no framework runtime. A redesign must not
regress: watch bundle size, conversation list virtualisation once lists are
long, message pagination, search debounce, and layout shift. The measured API
latencies in `LOAD_TEST_REPORT.md` are the server's half; the browser's half is
unmeasured and should be baselined before the redesign, not after.
