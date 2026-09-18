# CONVO RTL guide

Arabic is a first-class layout, not a mirrored afterthought.

## Layout

- Set document `dir` from the active language and use logical properties (`inline`, `block`, `inset-inline-*`, `border-inline-*`).
- The navigation and its mobile drawer begin on the inline-start side.
- Queue and context drawers use inline-start and inline-end respectively.
- Menus use logical trigger alignment and must remain within the viewport.

## Directional icons

- Mirror only directional meaning: back/forward, collapse/expand, previous/next.
- Never mirror non-directional glyphs such as search, settings, channel logos, status, attachment, or close.
- Down chevrons do not mirror. Side chevrons must follow reading direction.
- Keep icon hit areas identical in both directions.

## Mixed content

- Phone numbers, email addresses, message IDs, request IDs, dates, and URLs use isolated runs.
- Conversation body uses `unicode-bidi: plaintext` so each message chooses its own paragraph direction.
- Numeric table columns remain end-aligned and use tabular Latin digits from the formatter.
- Provider and product names inside Arabic text remain isolated; do not force the whole row LTR.

## Typography

- Do not reduce Arabic size to make it fit.
- Use normal or relaxed line-height for Arabic body copy.
- Avoid letter spacing on Arabic text. Brand Latin wordmarks may use tracking in an isolated element.

## QA checklist

- Sidebar icons share one x-axis and labels one baseline.
- Dropdowns and menus align to the logical trigger edge.
- Back, pagination, drawer, and collapse icons point correctly.
- Search/input affixes move to the logical end where appropriate.
- Timestamps, phone numbers, and emails do not reorder.
- Customer and agent messages retain semantic sides and readable paragraph direction.
- Focus order follows DOM/task order, not a visual-only mirrored order.
