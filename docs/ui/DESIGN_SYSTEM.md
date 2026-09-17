# Design system

**Status: the token layer is built and enforced. The component layer is not.**

This document describes what exists today accurately, and specifies what has to
be built. It does not describe a redesign, because none was performed — see
`UI_AUDIT.md` for why that sequencing was deliberate.

---

## Part 1 — what exists

### Layer architecture

CSS is organised into five explicit cascade layers, declared once:

```css
@layer tokens, base, components, shell, screens;
```

`tokens.css` is the **only** place a raw colour, size, radius, shadow or
duration is written; every later layer consumes `var(--token)`. That rule is
real rather than aspirational, and it is the strongest part of the current UI.

### Colour

Two blocks and no third: the light palette on `:root`, the dark palette on
`:root[data-theme='dark']`. There is deliberately no `prefers-color-scheme` copy
of the dark palette — `index.html` stamps `data-theme` before the first paint,
so a third block would only be somewhere for the two to drift apart.

The Digital School brand is applied: Berlitz Blue `#004fef` as the single action
colour, Digital Yellow as a deliberate highlight rather than a surface, Powder
work surfaces, Charcoal text.

| Group | Tokens |
| --- | --- |
| Surfaces | `--canvas`, `--surface-1..3`, `--surface-hover`, `--surface-selected` |
| Text | `--text`, `--text-secondary`, `--text-muted`, `--text-disabled` |
| Action | `--accent`, `--accent-hover`, `--accent-text`, `--accent-soft`, `--on-accent` |
| Status | `--success`, `--warning`, `--danger`, `--unknown`, each with a `-soft` tint |
| Structure | `--border-strong`, `--focus-ring` |
| Provider | `--brand-whatsapp`, `--brand-messenger`, `--brand-instagram`, `--brand-telegram` — confined to the small tile behind a channel glyph, never a surface |

**Contrast is enforced by a test.** `theme.test.ts` reads the `#rrggbb` values
between the `@tokens` markers, requires both themes to declare the same set, and
re-checks every WCAG pair listed in `src/theme.ts` against what is written. A
token that drifts out of contrast fails the build rather than shipping.

### Typography

One family for both scripts: **IBM Plex Sans Arabic**, self-hosted from
`/fonts`, SIL OFL 1.1, licence beside the files. No third-party font host is
contacted — which is a privacy property, not only a performance one.

```
--text-2xs 12  --text-xs 13  --text-sm 14  --text-md 15
--text-lg 17   --text-xl 20  --text-2xl 24
--weight-regular 400  --weight-medium 500  --weight-semibold 600
--leading-tight 1.35  --leading-normal 1.55  --leading-relaxed 1.7
```

Seven sizes for an operator console is a defensible scale: dense enough to build
hierarchy, small enough that nobody has to guess which one to use.

### Spacing, radius, motion

```
--space-half 2  --space-1 4  --space-2 8  --space-3 12  --space-4 16
--space-5 20    --space-6 24 --space-8 32 --space-10 40 --space-12 48
--radius-xs 4 --radius-sm 6 --radius-md 8 --radius-lg 10 --radius-xl 14 --radius-full 999
--motion-fast 120ms --motion-base 180ms --ease-out cubic-bezier(0.2,0.8,0.2,1)
```

The radius scale is restrained — 4 to 14px, with `--radius-full` reserved for
genuine pills. Motion is 120–180ms, which is fast enough not to slow an operator
down.

### Layout tokens

The operator layout is expressed as tokens rather than as magic numbers, which
is what lets the Playwright specs assert real geometry:

```
--nav-width-collapsed 64   --nav-width-expanded 232
--header-height 56         --list-width 336 (min 300, max 400)
--panel-width 304          --thread-min-width 560
--row-height 64            --control-height 34 (sm 30)
--composer-min-height 44   --composer-max-height 120
--page-max-width 1360
```

A three-column Inbox is already *described* by these tokens
(`nav + list + thread + panel`). What is missing is the screen that uses them
well — see `UI_AUDIT.md` F-4.

### Enforcement that already exists

| Property | How |
| --- | --- |
| One source for every raw value | the `tokens` layer, by convention and review |
| Both themes declare the same tokens | `theme.test.ts` |
| WCAG contrast pairs hold | `theme.test.ts` |
| Real geometry at 1440 and 1366 | `tests/e2e/layout.spec.ts` |
| No WCAG 2.1 AA violation | `tests/e2e/a11y.spec.ts`, axe |
| Screens do not change silently | `tests/e2e/visual.spec.ts` — both a 2% pixel ratio **and** a DOM-skeleton snapshot, because a pixel ratio cannot separate Arabic glyph jitter (~1.4%) from a real change (~2%) |

---

## Part 2 — what has to be built

**None of the following exists yet.** It is specified here so the work is
scoped, not so it can be described as done.

### The component layer

With no UI framework, every screen currently builds its own controls. That is
why inconsistency accumulates faster than it can be tidied. Before any visual
work, extract — against the existing tokens, changing no token values:

`Button` · `IconButton` · `Input` · `Textarea` · `Select` · `Combobox` ·
`Search` · `Tabs` · `Badge` · `Status` · `Tooltip` · `Dropdown` · `Modal` ·
`Drawer` · `Toast` · `Table` · `Pagination` · `Skeleton` · `EmptyState` ·
`ErrorState` · `Avatar` · `ChannelIcon` · `ConversationStatus` · `UserStatus`

Each must declare all nine states — default, hover, active, focus, selected,
disabled, loading, error, success — and each must be correct in both directions
and both themes. A component that only has a default state is where the next
inconsistency starts.

Do **not** introduce a UI framework to get this. The absence of one is why the
bundle is small and why there is no framework runtime on the operator's critical
path; a component library here is a set of functions returning elements, which
is what the existing `h()` helper already does.

### Message-type distinction

Specify before styling. Customer message, agent reply, **private note**, system
event and automation event must be unmistakable at a glance and must not rely on
colour alone. A private note that reads like a reply is how an internal comment
reaches a parent — this is a safety requirement, not a visual preference.

### RTL beyond `direction`

Mirrored chevrons and directional icons; dropdown, tooltip and drawer placement;
modal and drawer slide direction; mixed Arabic/Latin runs; phone numbers, dates
and numerals inside RTL text; table column order. Assert each, the way contrast
is already asserted.

### Responsive information architecture

Cover 1024, 768, 430 and 390 in addition to the two desktop widths already
asserted. For phone widths the architecture changes — queue, conversation and
context become separate views, not three narrow columns.

### Accessibility beyond axe

Keyboard-only operation of the Inbox; focus trapping in dialogs; visible focus
everywhere; screen-reader names for icon-only controls; contrast in both themes;
200% zoom; `prefers-reduced-motion`; touch targets.

### Performance budget

Baseline **before** the redesign, not after: bundle size, conversation list
virtualisation, message pagination, search debounce, layout shift. The server
half is measured in `LOAD_TEST_REPORT.md`; the browser half is not measured at
all yet.

---

## The rule for visual baselines

Update them **only** after looking at each screen. A changed snapshot is never
self-approving — that is the whole reason the visual suite carries a DOM
skeleton beside the pixel comparison.
