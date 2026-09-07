# ADR-0016 — Design tokens derived from the Figma reference, with provenance per value

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P1 design system
- **Requirement IDs:** UX-01, UX-02, UX-10

## Context

The reference is a public Figma Community file (Customer Support Chat Dashboard UI — SaaS Admin Panel, by Rashmi; the public page showed CC BY 4.0 during the v2 review). The v2 research inspected the **public preview visually**; it did **not** open editable nodes. The Figma MCP connector in this session is **unauthenticated**, so node-level measurement is currently unavailable.

The failure mode to avoid is inventing hex values and pixel dimensions and calling the result "pixel-perfect".

## Decision

**Every token carries a provenance label**, and the labels are machine-checkable:

| Label | Meaning |
|---|---|
| `measured` | Read from an editable Figma node or a pixel measurement of the reference image |
| `estimated` | Inferred from the public preview by eye |
| `derived` | Computed from another token (scale steps, tints) |
| `original` | Our own decision for a screen the reference does not contain |
| `a11y-override` | Deliberately different from the reference to meet WCAG 2.2 AA |

At P0 close, colour and spacing tokens are `estimated`; nothing may be described as measured until node access or an image measurement exists. The reference URL and the outstanding inspection task stay visible in `docs/design/design-reference.md` until then.

**We preserve the reference's grammar, not its pixels:** a light, compact, dense working environment — slim icon rail, grouped filters, conversation list, central timeline + composer, contact/notes panel. Screens the reference does not contain (Campaigns, Roles, Channels, Platform admin) are **original** designs extending that grammar, not the inbox screen reused for everything.

**Attribution is retained** per the licence observed on the public page, and the current licence is re-verified before release.

**Explicitly banned** in-app: decorative gradients, oversized KPI cards, excessive rounded containers, stock AI sparkles, marketing hero sections.

**Accessibility outranks fidelity.** Where the reference fails WCAG 2.2 AA (likely for some low-contrast secondary text), we deviate, label the token `a11y-override`, and record the deviation rather than hiding it.

## Consequences

- Some tokens will change once node access exists; because provenance is labelled, that change is a small, auditable diff rather than a redesign.
- Visual comparison evidence must state "approximation from public preview", never "pixel-perfect".

## Alternatives rejected

- **Invent a palette and claim fidelity.** Rejected: fabricated evidence.
- **Block the design system until Figma access exists.** Rejected: stalls independent work for an external dependency.
- **Copy Dribbble artwork.** Rejected: those are layout inspiration only; redistributing their artwork or logos is not licensed.

## How this is verified

- A token-provenance lint: every token in the theme file has one of the five labels.
- `docs/design/design-reference.md` lists the outstanding node-measurement task and the Figma connector's unauthenticated status.
- Visual QA at 375/768/1280/1440 px and 200% zoom, in Arabic and English, with residual differences recorded.
