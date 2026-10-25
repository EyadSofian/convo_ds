# Bug tracker — full-stack audit, 2026-10-24

Scope: `apps/api`, `apps/web` (browser app and `server.mjs` proxy), `packages/domain`.
Audited on `fix/meta-app-registration-and-queue-notifications` (44ab5e8); the fixes were then moved onto `main` (fe77d9f), checked against the 35 commits main had gained, and landed on `fix/inbox-realtime-hang-and-audit`.

Status legend: **Fixed** = changed in this pass with tests · **Open** = found, not changed (needs a decision or a bigger change).

## The hang ("switching tabs freezes until I refresh")

Root cause is server + browser together, not the tab click itself:

1. `realtime_events` is never pruned (there is no retention job anywhere).
2. A live stream opened with no cursor (every page load / refresh) started at the **oldest** retained event.
   - Under 5,000 events: the whole history was replayed into the browser, and the browser re-read both inbox lists **for every event** — thousands of requests against an API pool of 10 DB connections. Every request queued behind them → the screen looked frozen.
   - Over 5,000 events: the server answered `reset_required: too_far_behind` with a restart cursor at `oldest - 1`, so the reconnect got the same answer again — the inbox blanked to skeletons and reloaded every ~2 s, forever.
3. The production web proxy (`server.mjs`) never closed the upstream stream when the browser left (Node does not emit `aborted` for a GET whose body was already piped — verified). Every refresh/tab close left a stream polling the DB every 500 ms for up to 5 minutes, so refreshing made it worse.

| # | Area | Bug | Status |
|---|------|-----|--------|
| H1 | API realtime | Live stream without a cursor replays the full history | **Fixed** — stream starts at the newest event (`page(..., 'latest')`) |
| H2 | API realtime | `reset_required` restart cursor at `oldest - 1` → infinite reset loop | **Fixed** — restart cursor is the newest event |
| H3 | Web proxy | Upstream request not destroyed on browser disconnect (SSE leak) | **Fixed** — `response.on('close')` destroys upstream |
| H4 | API realtime | Stream loop kept querying after the client left (only listened on the request) | **Fixed** — also listens on the response socket, re-checks after sleep |
| H5 | Web | One realtime event = one full re-read of both lists; no coalescing | **Fixed** — `singleFlight`: one read in flight + one trailing |
| H6 | Web | Overlapping list reads: whichever answer arrived last won (old sort/filter overwrote new; lists could stay on skeletons) | **Fixed** — latest-read-wins tickets (`claimRead`) |
| H7 | Web | A failed background read left a never-loaded list on skeletons forever | **Fixed** — becomes an error state with Retry |
| H8 | Web | No request timeout: one stalled connection = infinite skeleton | **Already on main** (eef351d bounds GET reads at 30 s) — not changed here |
| H9 | Web | An action that threw left `live.busy` set → all busy-gated buttons dead until reload; unhandled rejection | **Fixed** — dispatcher releases busy/refreshing, shows a toast |
| H10 | Web | A screen load that threw never started realtime / deep link | **Fixed** — `afterLoad` runs after a failed load too |

## Inbox / conversations

| # | Area | Bug | Status |
|---|------|-----|--------|
| C1 | API + Web | After **Claim** on WhatsApp the claim response had no `serviceWindow` → composer said "cannot verify the WhatsApp window" until reload. Same after assign / priority / lifecycle responses | **Fixed** — API claim returns the window; web keeps the known window (`adoptConversation`) and re-reads it if missing |
| C2 | Web | Opening thread A then B quickly: A's late answers (record, timeline, notes, history, offers, contact) painted over B; A was marked read | **Fixed** — every per-thread load checks the thread is still open |
| C3 | Web | Realtime timeline read for a thread that was closed in the meantime replaced the open thread's messages | **Fixed** |
| C4 | Web | Claim from a queue card while another thread was open kept that thread's composer text, note draft, notes and history (cross-customer leak) | **Fixed** — drafts reset, sections reloaded |
| C5 | Web | Back/Forward (or a link) that changed inbox sort/filter/scope or the conversation id updated the URL but not the data | **Fixed** — route handler reloads lists / opens the named thread |
| C6 | API (business) | "Waiting longest" sort returned the **newest** waits first | **Fixed** — earliest `waiting_since` first, nobody-waiting last (cursor updated) |
| C7 | API (business) | Unassigned queue: `LIMIT 200` applied **before** the per-row scope check → a scoped agent could see an empty/partial queue while other inboxes filled the cap | **Fixed** — scope pushed into SQL (`previewScope`), per-row check kept as a guard |
| C8 | API (business) | Claim accepted an unassigned **archived** conversation (archived is immutable everywhere else) | **Fixed** — 409 `archived_conversation_is_immutable` |
| C14 | Web | On main's three tabs, **All → Unassigned → Mine** showed the All rows under Mine: Unassigned flipped the query to `mine` without reloading, so Mine reused the All rows as its cache (and a reload on Unassigned after All landed on All) | **Fixed** — Unassigned leaves the Mine/All query alone; the URL only says `scope` on Mine; Back/Forward between tabs reloads |
| C15 | Web | Switching Mine ↔ All quickly: the slower answer won, so a tab could show the other tab's rows | **Fixed** by H6 (latest read wins) |
| C9 | Web | "Mine" tab badge counted loaded rows only (showed 50 for 300) | **Fixed** — shows `50+` when more pages exist |
| C10 | Web | Contacts search: an older keystroke's answer could overwrite a newer one | **Fixed** — latest-read-wins |
| C11 | API (business) | Unassigning a `pending`/`snoozed` conversation hides it from both Unassigned (open-only) and Mine until the customer writes / it wakes | **Fixed** (2026-10-25, owner decision) — the Unassigned queue includes `pending` and `snoozed` work, shows its status on the card, and it stays claimable |
| C12 | API | Unassigned queue is capped at 200 with no pagination or "more" signal | **Open** |
| C13 | API | Any drift between the SQL inbox scope and the domain check turns the whole list into a 500 | **Open** — by design (fail closed); consider logging + dropping the row |

## Reporting / automations (business logic)

| # | Area | Bug | Status |
|---|------|-----|--------|
| R1 | API + Web | Analytics date filters were UTC days: for Cairo, 00:00–02:59 work landed on the previous day | **Fixed** for operations/assignments/responses/resolutions/teams — web sends `tz`, API uses local midnight (DST-safe); no `tz` = old behaviour |
| R2 | API | Campaign report (`/reports/campaigns`) still filters and buckets by UTC day (`reporting.service.ts` `to_char(... AT TIME ZONE 'UTC')`) | **Open** — same `tz` treatment needed |
| R3 | API + Web | Automations created **from a template** were hard-coded to `UTC` → "daily at 09:00" ran at 11:00/12:00 Cairo | **Fixed** — template use sends the operator's timezone (validated; default UTC) |
| R4 | API (business) | Broadcast audience: a contact with an old (closed) and a current identity on the same channel is counted twice — once "excluded: identity inactive", once "eligible" — so exclusions are overstated | **Open** |
| R5 | API | Audience search uses `LIKE '%' || search || '%'` without escaping `%`/`_` | **Open** (minor) |

## Operations / scale

| # | Area | Bug | Status |
|---|------|-----|--------|
| O1 | DB | `realtime_events` grows forever (no retention). Harmless for the hang now, but storage and `min/max/count` cost grow | **Open** — add a pruning job (keep e.g. 7 days) |
| O2 | API | Each open browser tab polls the DB twice a second over SSE; API pool is 10 connections per process | **Open** — consider LISTEN/NOTIFY or one shared poller per process |

## Verification

- Unit: 2,639 pass (2,621 before; 18 new). The only failures are `apps/api/src/workers/probe-server.test.ts` (11), which bind a TCP port — blocked by this sandbox, not a code bug (they fail the same way on the untouched branch).
- New tests: refresh coalescing, latest-read-wins, skeleton→error, stale thread answers, claim window, realtime start/restart cursor, queue scope SQL, waiting sort, Cairo report days, template timezone, All → Unassigned → Mine.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: pass.
- **Not run here:** integration, e2e, load (they need local Postgres/servers on ports). `tests/integration/api-realtime.test.ts` was updated for the new stream start (explicit from-start cursor where a test wants history, plus two new cases) — run `pnpm test:integration` before merging.
- **Not checked in a browser** (dev server cannot bind a port in this sandbox).
