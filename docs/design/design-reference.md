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
