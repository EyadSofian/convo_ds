# CONVO design system

CONVO is an operations workspace: calm, precise, information-dense, and fast. Its memorable quality is not decoration; it is the feeling that every state, count, and action has a deliberate place.

## Foundations

- Use the central custom properties in `apps/web/src/styles/tokens.css`. Raw colors belong there only.
- Use the 4px spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48. Two pixels is reserved for optical/internal corrections.
- Use IBM Plex Sans Arabic for Arabic and Latin so mixed text shares metrics. Keep phone numbers, email addresses, IDs, and code isolated with `bdi`, `.iso`, or `.mono`.
- Standard controls are 36px; compact controls are 32px. Icon-only controls use the same square dimension as their sibling controls.
- Standard icon sizes are 14, 16, 18, and 20px. Use 14 for metadata, 16 for controls, 18 for primary navigation, and 20 only for prominent empty/status marks.

## Color roles

- `--canvas`: application ground.
- `--surface-1`: primary reading/control surface.
- `--surface-2`: grouped secondary region and table header.
- `--surface-3`: compact neutral state, segmented control ground, and subtle metadata.
- `--surface-hover`: transient hover.
- `--surface-selected`: durable selection.
- `--border-subtle`, `--border`, `--border-strong`: separation, component boundary, and control boundary respectively.
- `--text`, `--text-secondary`, `--text-muted`, `--text-disabled`: strict text hierarchy.
- `--accent`, `--accent-hover`, `--accent-soft`: primary action, interaction, and selection. Accent must not become decoration.
- Success, warning, danger, and unknown are reserved for real semantic states.

Provider colors appear only behind provider/channel glyphs. They never color whole cards or primary actions.

## Typography

| Role | Token | Use |
|---|---:|---|
| Metadata | 12px | timestamps, request IDs, tertiary facts |
| Secondary UI | 13px | labels, hints, table headers |
| Standard UI | 14px | controls, tables, navigation |
| Conversation/body | 15px | messages and important descriptions |
| Section title | 17px | page chrome and strong panel titles |
| Page/status title | 20px | auth and major status headings |
| Display | 24px | rare onboarding/status moments |

Arabic uses at least the normal line-height. Do not tighten Arabic labels to compensate for space.

## Components

### Buttons

- Primary: one dominant next action per local region.
- Secondary: ordinary mutation or navigation.
- Ghost: chrome and low-emphasis actions.
- Danger: destructive action; danger text plus danger hover surface.
- Icon-only: always named for assistive technology; 32px compact or 36px standard.

All variants require default, hover, active, focus-visible, disabled, and busy behavior.

### Fields

Inputs, selects, textareas, and search fields share height, radius, border, focus ring, label gap, and disabled treatment. Error text sits with its field; server errors use the notice/error pattern. Do not use placeholders as labels.

### Badges

Badges are 22–24px high and use neutral, accent, success, warning, danger, or unknown tones. A status badge combines text with a dot where quick scanning benefits. Color never carries status alone.

### Panels and tables

Panels group related work, not every field. Their header has a quiet secondary surface; their body is the reading surface. Tables use a secondary header, start-aligned text, end-aligned numbers, compact rows, clear hover, and a durable selected state. Horizontal overflow stays inside `.tablewrap`.

### Overlays

Menus align to their trigger with logical inset properties. Dialogs are 520px by default and 680px for complex forms, constrained to the viewport. Header, scrollable body, and footer remain separate. Escape, focus trapping, and return focus are mandatory.

### Empty, loading, error

- Loading uses stable skeleton geometry.
- Empty state states what is absent and the next useful action.
- Permission denied is distinct from empty.
- Offline/server error offers retry and request ID where available.

## Motion and elevation

Use 120ms for hover/press and 180ms for drawers/overlays. Motion is disabled under `prefers-reduced-motion`. Use elevation only for floating layers, the auth surface, and the active composer; reading panels use no more than the smallest shadow.
