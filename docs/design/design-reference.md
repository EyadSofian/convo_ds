# CONVO — Design reference and tokens

Governed by ADR-0016. **Nothing in this file is a measured Figma node value.** Read section 1 before using any number here.

## 1. Access status — what we actually have

| Attempt | Date | Result |
|---|---|---|
| Figma MCP connector (`claude.ai Figma`) | 2026-09-07 | **Unauthenticated in this session.** OAuth cannot be completed from a non-interactive session. The user must authorize it from claude.ai connector settings. |
| `WebFetch` of the Community file page | 2026-09-07 | **HTTP 403 Forbidden.** No page content retrieved. |
| Inherited v2 research | 2026-09-07 | Public page and enlarged preview inspected **visually**; editable nodes were **not** accessed. Author recorded as Rashmi; the public page showed **CC BY 4.0** at that time. |

**Consequence:** every colour, size and spacing value below is `estimated` or `derived`. Until node access or a pixel measurement of the reference image exists, no visual comparison may be described as "pixel-perfect", and UX-01 stays `partial`.

**Outstanding task (blocking nothing else):** obtain Figma access — either by authorizing the Figma connector, or by placing an exported reference image at `docs/design/reference/` so values can be measured from pixels. Re-verify the current licence at the same time.

Reference: <https://www.figma.com/community/file/1514208352310179359/customer-support-chat-dashboard-ui-saas-admin-panel> — Customer Support Chat Dashboard UI – SaaS Admin Panel, by Rashmi. Attribution retained per the observed CC BY 4.0 licence (re-verify before release, UX-10).

Secondary inspiration (layout only — **no artwork, icons or logos are reused**): Dribbble shots *Unified Inbox* (Arafat Ovi), *Cosmo* (Royhan Darmawan / Flow Forge), *Closr* (Filllo).

## 1a. Superseded by the Milestone A token layer (2026-09-09)

**§4 below is historical.** The palette, type scale and several layout values in that section were
replaced during the Milestone A rebuild. The binding source is now:

- `apps/web/src/theme.ts` — both palettes as data, with the WCAG requirement list.
- `apps/web/src/styles/tokens.css` — what the browser reads.
- `apps/web/src/theme.test.ts` — fails the build if the two disagree, and re-checks every contrast
  pair on both themes.

What changed, and why:

| §4 value | Replaced by | Reason |
|---|---|---|
| `--surface-app: #F7F8FA` and the light greys around it | `#eef1f5` ground with a darker `--text-muted: #5e6980` | `#68738a`-class muted text measured **4.21:1** on the grey ground — below AA. The whole neutral ramp was re-derived from contrast arithmetic rather than adjusted by eye. |
| "Dark theme: **not yet defined**" | A complete dark palette | It is defined now, and every pair is tested. This was the largest honest gap in §4. |
| `--font-sans: Inter, "IBM Plex Sans Arabic", …` | `'Readex Pro'` + system fallback, self-hosted | One Arabic-first family carrying both scripts, so Arabic and Latin share one metric instead of two faces disagreeing at the same size. Shipped with its SIL OFL 1.1 licence; no third-party font host is contacted. |
| `--text-sm: 13px` used for body copy | body 14–15px, conversation copy 15px | The brief's readable band. Nothing primary sits below 12px, asserted in `tests/e2e/layout.spec.ts`. |
| `--list-width: 320px`, `--row-height-compact: 64px` | `--list-width: 332px` (resizable 300–380), `--row-height: 68px` | Measured against the eight-visible-rows requirement at 1366×768. |
| Provenance labels | unchanged in spirit | Still **zero** `measured` values. The Figma file is still 403 to automated fetch (§1). Nothing here may be described as pixel-matching it. |

The **layout contract in §3 is superseded too**: the drawer/overlay thresholds are now arithmetic
derived from the 640px timeline floor (1260 / 1364 / 1596px promotion, 1027 / 719px drawer), and they
are documented at the top of `apps/web/src/styles/shell.css` and asserted in
`tests/e2e/layout.spec.ts`.

The §6 component state contract and the §5 bidirectionality rules are **not** superseded — they were
implemented, and both are now enforced by tests (`theme.test.ts` forbids physical `left`/`right` in
layout CSS; `layout.spec.ts` asserts a mixed Arabic/Latin message keeps its own base direction).

## 1b. Operator UI redesign (2026-09-13) — the binding values today

§1a's palette, font and layout numbers were replaced again by the operator UI redesign. The sources
of truth are unchanged in kind — `styles/tokens.css` (one `:root` light block, one
`:root[data-theme='dark']` block, no media-query copy), `theme.ts` and `theme.test.ts`, which parses
the CSS and re-checks every contrast pair in both themes. Provenance is still `original` /
`a11y-override`; nothing here is `measured`.

### Palette

| Token | Light | Dark | Note |
|---|---|---|---|
| `--canvas` | `#f4f3f0` | `#0b0d12` | Warm paper / graphite-navy ground |
| `--surface-1` / `-2` / `-3` | `#fcfbf9` / `#f7f6f3` / `#efeee9` | `#11141b` / `#171b24` / `#1d2230` | Reading surfaces are opaque |
| `--border` | `rgba(20,24,32,.10)` | `rgba(255,255,255,.08)` | Hairlines |
| `--text` / `--text-muted` | `#17191f` / `#5f6674` | `#f4f5f8` / `#959eae` | Muted light text was darkened from the brief's `#697180` to pass AA on every surface |
| `--accent` | `#6558d9` | `#6554e6` | Violet, not cyan. Dark accent sits deeper so white-on-accent passes 4.5:1 |
| `--accent-text` | `#5346c9` | `#a59bff` | Accent used *as text* has its own contrast-tested value |
| `--focus-ring` | `#6558d9` | `#a59bff` | 2px ring on every control; the composer draws it on its box |

Translucency (`--glass`, `--nav-surface`) is used only by the navigation, menus, popovers and
toasts — chrome and floating layers, never a surface anybody reads a conversation on. No gradients.

### Type

**IBM Plex Sans Arabic** replaces Readex Pro, self-hosted at 400/500/600 with its SIL OFL 1.1 text at
`apps/web/public/fonts/IBM-Plex-OFL.txt`; no font host is contacted. Alexandria was the other
candidate: it is display-leaning, and at 13–15px in dense tables and queue rows its Latin and digits
read wider and looser than Plex, whose Arabic and Latin were drawn as one system with even figure
widths. Scale: 13 / 14 / 15 / 17px for `--text-xs` … `--text-lg`; badges and timestamps may sit at
12px, primary copy never below 13px (asserted in `tests/e2e/layout.spec.ts`). Western digits 0–9 in
both languages, tabular numerals wherever figures are compared.

### Layout contract (asserted in `tests/e2e/layout.spec.ts`)

| Element | Value |
|---|---|
| Navigation | 64px collapsed (default), 232px expanded, remembered per browser; an overlay drawer with a focus trap below 960px |
| Header | 56px: page title, company name (a real switcher only with two or more memberships), language, theme, account menu |
| Queue list | 336px default, keyboard/pointer resizable 300–400px; ≥8 rows visible at 900px height |
| Thread | Never squeezed below 560px; the widest column |
| Customer panel | 304px inline when the screen area is ≥1200px, otherwise a drawer; collapsible |

The inbox decides its columns with a container query on the screen area, because the navigation can
be 64px or 232px wide and a viewport breakpoint cannot know which. The thresholds are documented at
the top of `apps/web/src/styles/shell.css`.

---

## 2. Observed structure (from the visual inspection, not measured)

A light, compact, information-dense working environment:

```
┌──┬─────────────────┬───────────────────────────────┬──────────────────┐
│  │ grouped filters │  conversation timeline        │  customer panel  │
│ic│ + saved views   │                               │  identities      │
│on│─────────────────│                               │  attributes      │
│  │ conversation    │                               │  consent         │
│ra│ list            │                               │  notes           │
│il│ (virtualized)   │───────────────────────────────│  linked CRM      │
│  │                 │  composer (reply / note tabs) │  history         │
└──┴─────────────────┴───────────────────────────────┴──────────────────┘
```

Observed characteristics: slim icon rail; grouped inbox filters above the list; blue outgoing bubbles; restrained warm accents; light neutral ground; tight vertical rhythm. **Not** a KPI-card analytics dashboard, and it must not become one.

## 3. Layout contract

| Breakpoint | Behaviour |
|---|---|
| ≥1440 px | All four columns visible |
| 1280–1439 px | Customer panel collapses to a toggle first — **the chat is never sacrificed first** |
| 768–1279 px | Inbox list becomes a drawer; timeline + composer keep full width |
| <768 px | One primary conversation view; list and panel are separate routes |
| 200% zoom | Must remain operable; no clipped composer, no focus trap, no horizontal page overflow |

Test viewports: 375, 768, 1280, 1440 px, plus 200% zoom, in **both** Arabic (RTL) and English (LTR).

## 4. Tokens

Provenance labels (ADR-0016): `measured` | `estimated` | `derived` | `original` | `a11y-override`.
At P0 there are **zero** `measured` values. This is the honest baseline.

### 4.1 Colour — light theme

| Token | Value | Provenance | Note |
|---|---|---|---|
| `--surface-app` | `#F7F8FA` | estimated | Light neutral ground |
| `--surface-panel` | `#FFFFFF` | estimated | Lists, panels, composer |
| `--surface-raised` | `#FFFFFF` | derived | + shadow token |
| `--surface-sunken` | `#EEF0F4` | derived | Timeline background |
| `--border-subtle` | `#E4E7EC` | estimated | 1px hairlines |
| `--border-strong` | `#CDD2DA` | derived | Inputs, dividers |
| `--text-primary` | `#12161C` | estimated | ≥ 7:1 on panel |
| `--text-secondary` | `#5A6373` | a11y-override | Raised from the apparent reference tone to reach 4.5:1 |
| `--text-disabled` | `#98A0AE` | derived | Never carries meaning alone |
| `--accent` | `#2563EB` | estimated | Outgoing bubbles, primary action |
| `--accent-hover` | `#1D4ED8` | derived | |
| `--accent-subtle` | `#E8EFFE` | derived | Selected row, focus ring halo |
| `--warm-accent` | `#F59E0B` | estimated | Restrained warm accent seen in the reference |
| `--status-success` | `#15803D` | original | Delivered/connected — always paired with an icon or label |
| `--status-warning` | `#B45309` | original | Degraded, pending, quota |
| `--status-danger` | `#B42318` | original | Failed, rejected, disconnected |
| `--status-unknown` | `#6B4EFF` | original | **`outcome_unknown` gets its own colour** — it is not a shade of failure |
| `--focus-ring` | `#2563EB` | a11y-override | 2px, 2px offset, always visible |

Dark theme: **not yet defined.** Deriving it before the light palette is measured would create two sets of guesses. Tracked as an open task.

Status colour is never the only signal: every status also carries an icon and text (WCAG 2.2 AA, UX-06).

### 4.2 Type

| Token | Value | Provenance |
|---|---|---|
| `--font-sans` | `Inter, "IBM Plex Sans Arabic", system-ui, sans-serif` | original — Arabic face chosen for legibility at small sizes |
| `--text-xs` / `--text-sm` / `--text-base` / `--text-lg` / `--text-xl` | 12 / 13 / 14 / 16 / 20 px | estimated (compact scale consistent with the reference density) |
| `--weight-regular` / `--medium` / `--semibold` | 400 / 500 / 600 | estimated |
| `--leading-tight` / `--normal` | 1.35 / 1.55 | derived — Arabic needs more leading than Latin at the same size |

Arabic and Latin share the scale; the Arabic face is selected per-script through `font-family` fallback, not by swapping the whole theme.

### 4.3 Space, radius, elevation

| Token | Value | Provenance |
|---|---|---|
| `--space-1..8` | 2, 4, 8, 12, 16, 24, 32, 48 px | derived (4px base) |
| `--radius-sm` / `--md` / `--lg` / `--full` | 4 / 6 / 10 / 9999 px | estimated |
| `--shadow-panel` | `0 1px 2px rgba(16,24,40,.06)` | estimated |
| `--shadow-overlay` | `0 8px 24px rgba(16,24,40,.12)` | derived |
| `--rail-width` | 56 px | estimated |
| `--list-width` | 320 px | estimated |
| `--panel-width` | 340 px | estimated |
| `--row-height-compact` | 64 px | estimated |

**Banned:** decorative gradients, oversized KPI cards, excessive rounding, stock AI sparkles, marketing hero sections inside the application.

## 5. Bidirectionality

- Layout uses **logical properties only** (`margin-inline-start`, `padding-block`, `inset-inline-end`). No `left`/`right` in layout CSS.
- Phone numbers, IDs, emails, URLs and provider message IDs are wrapped in directional isolation (`<bdi>` / `unicode-bidi: isolate`) so a mixed Arabic/Latin string never reorders visually.
- Logos, avatars, media, charts and directional product screenshots are **not** mirrored. Navigational chevrons are.
- Information hierarchy is identical in both directions — RTL is not a different layout, it is the same layout mirrored where mirroring is correct.
- Arabic text length is validated in **UTF-8 bytes as well as characters** wherever a provider limit applies.

## 6. Component state contract

Every component in the catalogue must implement each applicable state, and Storybook must show it:

`default` · `hover` · `focus-visible` · `active` · `disabled` · `loading` · `empty` · `error` · `permission-denied` · `offline/stale` · `read-only`

`permission-denied` is a real state, not a hidden element: the user is told the action exists and that they lack the grant, and the endpoint enforces it regardless.

## 7. Screen inventory

| Screen | Source | Status |
|---|---|---|
| Inbox (rail, filters, list, timeline, composer, customer panel) | reference grammar | designed at P0, built in P2 |
| Conversation queue card (unassigned, projected fields only) | original | P2 — must not leak transcript/PII |
| Contacts list / detail / merge review | original | P3 |
| Import wizard with row-level errors | original | P3 |
| Channels: connect, health, reconnect, capabilities | original | P2/P3 |
| Templates: list, editor, preview, sync status | original | P3 |
| Campaign wizard: objective → audience → content → schedule/budget → review | original | P4 |
| Campaign detail: recipient ledger, error categories, in-flight/unknown | original | P4 |
| People / Roles editor with effective-access preview | original | P1 |
| Teams, business hours, routing, SLA policies | original | P1/P6 |
| Integrations: Odoo mapping, conflicts, health | original | P5 |
| Developer: API keys, webhook subscriptions, deliveries | original | P5 |
| Automation builder + simulator + run trace | original | P6 |
| Reports with published denominators and freshness | original | P6 |
| Platform console (tenants, quotas, placement, health) | original | P1 |
| Onboarding / bootstrap / empty states | original | P1 |
| AI settings, knowledge sources, tool approvals | original | P7 |

Screens marked `original` extend the reference's grammar — dense, light, quiet. They are **not** the inbox screen reused with different data, and they are **not** a generic analytics dashboard.

## 8. Content rules for acceptance evidence

Realistic synthetic Arabic and English content only: long names, mixed-script strings, phone numbers, order IDs, emoji, missing avatars, very long threads, empty inboxes. **No lorem ipsum. No invented statistics.** Screenshot comparisons use the same viewport, data and state on both sides, and residual differences are recorded rather than smoothed over.
