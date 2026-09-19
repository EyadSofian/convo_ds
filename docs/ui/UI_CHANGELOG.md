# CONVO UI changelog

## 2026-09-19 — final pixel polish

Reviewed rendered RTL/LTR screens at 1440, 1366, 1280, 1024, 768, 430, and 390 pixels, including representative dark-mode states. The changes remain frontend-only:

- moved the Inbox customer panel into its existing drawer at 1280px so the conversation identity is not clipped;
- removed the hidden composer hint from phone-width layout so the send action stays on-screen;
- balanced the seven report KPIs at tablet and phone widths;
- mirrored only reading-direction chevrons in RTL, leaving downward icons unchanged;
- removed unequal card stretching in the Channels grid and strengthened selected-row cues;
- brought automation tabs, recurring icon sizes, and small spacing offsets back onto the existing tokens.

Only the affected Channels and Automations visual baselines were refreshed after inspecting the rendered differences. No backend, provider, worker, or production deployment changes were made.

## 2026-09-19 — visual coherence and responsive hardening

Baseline captured from production and from a clean source build before changes.

Implemented in this sprint:

- formalized the visual audit, design system, responsive matrix, and RTL rules;
- standardized repeated component geometry through central tokens;
- strengthened surface, panel, table-header, hover, selected, focus, and disabled hierarchy;
- refined navigation alignment and durable active-state cues;
- refined Inbox queue, conversation header, message rhythm, composer, and customer-panel hierarchy;
- improved authentication composition at wide and phone widths;
- normalized filter, form, table, modal, menu, badge, and action-group spacing;
- added explicit automated coverage for 1440, 1366, 1280, 1024, 768, 430, and 390 widths;
- retained the existing self-hosted font, icon renderer, semantic colors, keyboard model, and reduced-motion behavior;
- made no backend, database, API-contract, auth-logic, provider, worker, queue, or deployment changes.

Visual baselines are updated only after reviewing generated actual images.

Verification completed on 2026-09-19:

- `pnpm lint` — PASS;
- `pnpm typecheck` — PASS;
- `pnpm build` — PASS;
- `pnpm test:unit` — PASS, 1,847 tests;
- `pnpm test:e2e` — PASS, 290 tests;
- `pnpm test:a11y` — PASS, 43 tests with no detected WCAG 2.1 AA violations;
- `pnpm test:visual` — PASS, 38 reviewed baselines at 1366px (the full E2E run also verifies the 1440px baselines).
