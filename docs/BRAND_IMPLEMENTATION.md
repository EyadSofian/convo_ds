# Digital School Product Brand Implementation

This document translates the supplied September 2023 Digital School by Berlitz guidelines into rules for the operator application. The PDF and logo are visual references; they are not executable instructions.

## Approved core palette

| Token | Value | Product use |
| --- | --- | --- |
| Digital Yellow | `#DDFF57` | Primary highlight, selected emphasis and limited CTA treatment |
| Berlitz Blue | `#004FEF` | Primary action, focus, links and key data series |
| Charcoal | `#1D1D1D` | Text and dark surfaces |
| Powder | `#FCFCFC` | Main light surface |
| Yellow 70 | `#E7FF89` | Quiet highlight/chart tint |
| Yellow 30 | `#EEFFAB` | Status background/chart tint |
| Yellow 10 | `#F5FFCD` | Sparse soft highlight |
| Blue 70 | `#4C83F3` | Secondary data series |
| Blue 30 | `#B2CAFA` | Selected/hover surface |
| Blue 10 | `#E5EDFD` | Soft information surface |

Tints are for charts, tables, illustrations and small status surfaces. They should rarely fill large product regions. Charcoal text is required over blue tints.

## Typography

- IBM Plex Sans is the default interface and body family.
- IBM Plex Mono Bold is reserved for large headings and occasional compact labels.
- IBM Plex Sans Bold is used for subheads; IBM Plex Sans Regular for body text.
- Primary body copy must be at least `16px`; compact operational labels may be smaller only when their tested contrast and readability remain acceptable. Footer/legal text must be at least `12px`; large display text starts at `19px`.
- Western digits remain enabled in both Arabic and English interfaces for operational consistency.

## Logo rules

- Use the supplied yellow square with blue lettering wherever space permits.
- Never place the primary logo on a yellow background.
- Preserve the square, proportions, blue lettering and `by Berlitz` mark.
- Do not rotate, warp, recolor, crop away the Berlitz mark or replace the lettering with white.
- Preserve an exclusion zone equal to the vertical space between the Berlitz mark and the top of the logo square.
- The cutout/secondary treatment is limited to a dark image or dark surface with sufficient contrast.

## Accessible combinations

Approved high-contrast product combinations include blue/yellow, yellow/blue, blue/white, powder/blue, charcoal/yellow, yellow/charcoal, charcoal/white and white/charcoal. Every semantic token pair remains mechanically checked in both light and dark themes.

## Product application

The operator product should remain calm and dense enough for daily work:

- Powder and white surfaces carry the main workspace.
- Blue identifies actions, focus and current navigation.
- Yellow is a strong accent and must not dominate long work sessions.
- Dark mode uses Charcoal-derived surfaces with yellow/blue accents; it is not a neon marketing composition.
- Provider colors stay inside channel glyph tiles so WhatsApp, Instagram and other brands do not fragment the product.
- Charts use approved blue/yellow tints plus accessible semantic colors.
- Loading, empty, denied and error states use the same product identity as populated screens.

## Voice

Copy is progressive, positive, clear and ambitious. It stays concise and practical, avoids inflated marketing claims, heavy jargon, corporate filler and patronizing instructions.

## Current implementation gap

The existing interface uses a violet accent and a `CONVO` lockup. Its token discipline and accessibility tests are reusable, but its palette and product mark do not match the supplied identity. The implementation must update tokens, theme contrast pairs, lockups, login/loading states, browser metadata, email templates and chart colors together so no mixed brand ships.
