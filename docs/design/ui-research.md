# CONVO — UI research log (inbox information architecture)

Purpose: record the **public product references** consulted before rebuilding `apps/web`, the exact
patterns taken from each, and what was *not* taken. Governed by ADR-0016 and
[`design-reference.md`](./design-reference.md), which remains the binding visual direction.

**Scope of what was copied: information architecture and interaction patterns only.** No artwork,
icon set, illustration, logo, brand colour, typeface pairing, marketing copy or product string was
reused from any source below. Where a source's label reads naturally in English it is recorded here
as evidence of a *pattern*, and CONVO's own Arabic-first wording is used in the product.

Date of research: 2026-09-08. Method: `WebSearch` + `WebFetch`, plus direct reads of Chatwoot's
public source on GitHub (AGPL-3.0) for exact filter grammar rather than paraphrasing a marketing page.

---

## 1. Access results — honest record

| Source | URL | Result |
|---|---|---|
| Figma Community reference | <https://www.figma.com/community/file/1514208352310179359/customer-support-chat-dashboard-ui-saas-admin-panel> | **HTTP 403 Forbidden** via `WebFetch`, 2026-09-08. Same failure already recorded in `design-reference.md` §1 on 2026-09-07. Search confirms the file exists under the title *Customer Support Chat Dashboard UI – SaaS Admin Panel*; **no page content, no node values, no image was retrieved this session.** |
| Chatwoot help centre (`chatwoot.com/hc/...`) | see §3 | `WebFetch` returned empty for every `chatwoot.com` article URL tried (4 attempts, different articles). Worked around by reading the **public source repository** instead, which is a stronger primary source for filter grammar. |
| Chatwoot marketing page for filters | <https://www.chatwoot.com/features/conversation-filters> | `WebFetch` returned empty. Content recovered indirectly through `WebSearch` result snippets and confirmed against source. |
| Chatwoot API reference | <https://developers.chatwoot.com/api-reference/conversations/conversations-filter> | Fetched successfully. |
| Chatwoot source (GitHub raw) | see §3 | Fetched successfully. |
| respond.io help centre | see §2 | Fetched successfully (3 pages). |

**Consequence for the Figma reference:** the visual direction implemented in `apps/web` is derived
from `design-reference.md` §2–§4 — which itself records a *visual* inspection, not measured nodes —
and **not** from anything retrieved this session. Nothing in the rebuilt UI may be described as
matching the Figma file pixel-for-pixel. UX-01 stays `partial`.

---

## 2. respond.io — inbox shell, standard groups, row anatomy

Sources fetched:

1. <https://respond.io/help/inbox/inbox-overview>
2. <https://respond.io/help/inbox/managing-conversations-in-inbox>
3. <https://respond.io/help/inbox/custom-inbox>

### Patterns adopted

| Observed pattern | Source | Where it lands in CONVO |
|---|---|---|
| **Three working columns**: left side panel of inbox *selection*, centre conversation list, right vertical sidebar of contact details/activities/attachments/integrations. | [1] | CONVO uses the same split but adds the slim icon rail as a separate zone, so the "inbox selection" column is purely grouped views/filters. Five zones total. |
| **Standard inbox groups are a small fixed set**: *All*, *Mine*, *Unassigned*, plus a self-view for conversations you collaborate on. | [1] | CONVO's queue segment: `All / Unread / Read / Mine / Unassigned`. Unread/Read added because the brief requires them; "Collaborations" is not modelled (CONVO has no collaborator concept in `business-rules.md`). |
| **Group membership is role-dependent** — restricted agents see only *Mine* and *Collaborations*; owners/managers see all groups. | [1] | CONVO gates groups on permission keys (`conversation.read` scope vs `conversation.unassigned.preview`), not on role name. The Agent persona in the demo sees a *projected* queue for Unassigned. |
| **Inbox side panel is grouped by kind**: Standard, Team, Custom, Blocked. | [1] | CONVO groups the views column into *Standard views* / *Inboxes* / *Teams* / *Saved views*, matching `docs/api/operation-inventory.md`'s `GET T/views`, `GET T/inboxes`, `GET T/teams`. |
| **Row anatomy**: channel icon badged onto the avatar's corner; status label shown only for non-open states ("Closed", "Snoozed") — an open conversation shows no status chip; unread shown as a numeric count in a filled circle; last message line carries a timestamp plus a direction arrow (outgoing vs incoming). | [2] | Adopted almost wholesale: channel glyph badged on the avatar, status pill suppressed for `open`, numeric unread pill, direction marker on the preview line. CONVO adds assignee name + SLA cue, which the brief requires. |
| **Selected row is highlighted**; default sort is newest-message-first; default group is *All*. | [2] | Same defaults. |
| **Row quick actions**: close, close-with-note, snooze, assign to a team member, shortcuts. | [2] | CONVO's conversation header carries assign / status / snooze / priority; "close with note" maps onto CONVO's *required disposition* on resolve (`business-rules.md` §4). |
| **Custom Inbox = a named, saved set of filter conditions**, created with a `+` next to the group label, with **nested conditions**, and a **sharing model of Private / Public / Shared-with-specific-users-or-teams**. | [3] | CONVO's *Saved views* group: `+` affordance beside the group heading, a save-current-filters dialog, and a visible scope selector (Private / Team / Workspace). Nested condition trees are **not** implemented — CONVO's filter is a flat AND-of-ORs, which is what the brief's chip UI can honestly represent. |
| Filter fields offered: Contact Field (incl. custom), Channel, Contact Tag, Last Interacted Channel, Time Since Last Incoming Message. | [3] | *Time since last incoming message* is the pattern behind CONVO's **SLA state** and **wait time** cues; *Contact Tag* → **labels**. |
| Unread counts expire after long inactivity rather than being deleted. | [2] | Not adopted — noted only. CONVO's unread is a per-user cursor (`business-rules.md` §4), a different mechanism. |

### Patterns deliberately rejected

- Respond.io's **Chats / Calls tabs** above the list — CONVO has no voice channel in scope.
- Its **Lifecycle stages** and **AI Agent assignment** — out of the current phase.

---

## 3. Chatwoot — filter grammar, saved folders, sort orders

`chatwoot.com` article pages would not render through `WebFetch`, so the exact grammar was read from
the project's public source and API reference instead. Files read (branch `develop`, 2026-09-08):

- `app/javascript/dashboard/components/widgets/conversation/advancedFilterItems/index.js`
- `app/javascript/dashboard/components/widgets/FilterInput/FilterOperatorTypes.js`
- `app/javascript/dashboard/components/widgets/conversation/ConversationBasicFilter.vue`
- `app/javascript/dashboard/i18n/locale/en/advancedFilters.json`
- `app/javascript/dashboard/i18n/locale/en/chatlist.json`
- API reference: <https://developers.chatwoot.com/api-reference/conversations/conversations-filter>

### Exact grammar observed

**Filter payload** (API reference): an array of objects, each
`{ attribute_key, filter_operator, values[], query_operator }`, where `filter_operator ∈
{equal_to, not_equal_to, contains, does_not_contain}` and `query_operator ∈ {AND, OR}`, with the last
element's `query_operator` null. The wider operator set in the UI source adds `is_present`,
`is_not_present`, `is_greater_than`, `is_less_than`, `days_before`, `starts_with`.

**Filterable attributes** (`advancedFilterItems/index.js`), grouped in the UI as *Standard Filters*
then *Additional Filters*:

| `attributeKey` | input type | group |
|---|---|---|
| `status` | multi_select | standard |
| `assignee_id` | search_select | standard |
| `priority` | multi_select | standard |
| `inbox_id` | search_select | standard |
| `team_id` | search_select | standard |
| `contact_id` | search_select | standard |
| `display_id` | plain_text | standard |
| `campaign_id` | search_select | standard |
| `labels` | multi_select | standard |
| `created_at` | date | standard |
| `last_activity_at` | date | standard |
| `browser_language` | search_select | additional |
| `referer` | plain_text | additional |

**Basic (always-visible) filters** (`ConversationBasicFilter.vue`): a status select of
`open / resolved / pending / snoozed / all`, and a sort select. Sort options
(`chatlist.json → SORT_ORDER_ITEMS`) include last-activity asc/desc, created-at asc/desc,
priority asc/desc, "Pending Response" (waiting-since) asc/desc, and unread-count-highest-first.

**Assignee tabs** (`chatlist.json → ASSIGNEE_TYPE_TABS`): exactly `Mine`, `Unassigned`, `All`.

**Saved filters are called *Folders*** (`advancedFilters.json`): a folder has a *Folder Name* and a
*Folder Query*; the dialog offers *Add filter*, *Apply filters*, *Update folder*, *Clear filters*.

### Patterns adopted

| Observed | Where it lands in CONVO |
|---|---|
| Two-tier filtering: a small always-visible basic row (status + sort) over a richer popover of attribute filters. | CONVO's list header keeps queue segment + sort inline; everything else lives in the grouped filter popovers on the views column and the list toolbar. |
| The **attribute set itself** — status, assignee, priority, inbox, team, labels, created/last-activity date — is the industry-standard spine. | CONVO implements assignee (multi-select), inbox, team, channel, status, priority, labels, SLA state, date and sort. `contact_id`, `display_id`, `campaign_id`, `browser_language` and `referer` are not surfaced in the demo inbox; `display_id` search is folded into the single search box. |
| **Multi-select for enumerable attributes, search-select for entity attributes.** | Assignee and inbox/team use a searchable multi-select; status/priority/channel/labels/SLA use plain multi-select chips. |
| **Named saved queries in the sidebar**, editable and deletable, with an explicit *Clear filters*. | CONVO's *Saved views* group, plus a persistent **Clear all** control beside the active-filter chips. |
| **Sort by "pending response" / waiting-since**, not just recency. | CONVO's sort offers newest, oldest, SLA-risk-first, priority-first and unread-first. |
| Conversation statuses `open / pending / snoozed / resolved` (plus `all`). | Identical to CONVO's own lifecycle in `business-rules.md` §4 — convergent, already ours before this research. |

### Patterns deliberately rejected

- **Free-form AND/OR condition builder with per-condition operators.** CONVO uses a flat model
  (OR within an attribute, AND across attributes) because that is what active-filter *chips* can
  represent truthfully. A chip row cannot honestly display a nested boolean tree.
- **`is_present` / `does_not_contain` operators** — no place in a chip UI at this phase.
- Chatwoot's visual design, component library, colours and icons: **not used**. Only the IA.

---

## 4. Figma Community reference — what is and is not evidenced

The named reference (*Customer Support Chat Dashboard UI – SaaS Admin Panel*) is **403 to automated
fetch**. The only description of its grammar available to this build is the prior visual inspection
recorded in `design-reference.md` §2: slim icon rail, grouped filters above the list, blue outgoing
bubbles, restrained warm accents, light neutral ground, tight vertical rhythm, explicitly *not* a
KPI-card analytics dashboard.

The rebuild implements exactly that description and the token table in `design-reference.md` §4.
It does **not** claim visual equivalence with the Figma file. To close this properly, either the
Figma connector must be authorised interactively, or an exported reference image must be placed in
`docs/design/reference/` so values can be measured — the outstanding task already recorded in
`design-reference.md` §1.

Related public Figma Community listings surfaced by the same search (titles only, not fetched, not
used): *Customer Support Dashboard UI Kit*, *AI Agent Workspace UI Template*, *Customer Support
Responsive UI*. Recorded for provenance so a future reader knows they were seen and skipped.

---

## 5. Net design decisions taken from this research

1. **Five zones, not four.** The views/filters column is separated from the conversation list
   (respond.io [1] splits inbox *selection* from the conversation list; the brief requires it).
2. **Queue segment = All / Unread / Read / Mine / Unassigned.** *Mine* / *Unassigned* / *All* are the
   observed standard trio in both products; Unread/Read are added per the brief.
3. **Grouped views column**: Standard views → Inboxes → Teams → Saved views, each group collapsible,
   each row carrying a count. Groups mirror respond.io's Standard/Team/Custom grouping [1] and
   Chatwoot's folder-in-sidebar placement.
4. **Filter attributes**: assignee (multi), inbox, team, channel, status, priority, labels, SLA
   state, date range, sort. Union of the two products' standard sets, minus what CONVO has no data
   for.
5. **Flat filter algebra** (OR within attribute, AND across attributes) so the active-filter chip row
   is a truthful rendering of the query.
6. **Row anatomy** from respond.io [2]: avatar with channel badge, status pill suppressed when open,
   numeric unread pill, direction marker, timestamp — plus assignee and SLA cue.
7. **Saved views carry a visible sharing scope** (Private / Team / Workspace), from respond.io's
   custom-inbox sharing model [3].
8. **Sort includes a wait-time/SLA order**, from Chatwoot's `waiting_since_*` options.

Everything else — the tenancy model, the projected unassigned queue card, consent/suppression,
`outcome_unknown`, the channel-window state, the permission-denied state — is CONVO's own product
design from `docs/product/business-rules.md`, not taken from any reference.

---

## 5a. Second research pass — 2026-09-09 (Milestone A rebuild)

Re-run against the exact URL list in `docs/execution/CLAUDE-LIVE-MVP-TASK.md` §1, with a stdlib
fetcher (`urllib` + `html.parser`; `beautifulsoup4` is not installed in this environment).
Method and results are recorded before the patterns, so a reader can see what was and was not
actually retrieved.

### Access results — honest record

| Source | Result 2026-09-09 |
|---|---|
| <https://developers.chatwoot.com/api-reference/conversations/conversations-list> | **200, 12,789 chars.** Read. |
| <https://respond.io/help/inbox/getting-started-with-inbox> | **200, 11,240 chars.** Read. |
| <https://respond.io/help/channels> | **200, 2,045 chars.** Read (channel catalogue index). |
| <https://respond.io/help/whatsapp/whatsapp-api-quick-start> | **200, 12,866 chars.** Read. |
| <https://www.chatwoot.com/hc/user-guide/en/categories/chatwoot-101> | **BLOCKED — connection timed out.** No content retrieved. Same failure mode as the 2026-09-08 attempt. |
| <https://www.chatwoot.com/features/conversation-filters> | **BLOCKED — connection timed out.** No content retrieved. |
| <https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api> | **BLOCKED — HTTP 200 but zero text.** Postman's documentation renders client-side; the served HTML carries no prose. |
| <https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api> | **BLOCKED — HTTP 200 but zero text.** Same client-side rendering. |
| <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api> | **BLOCKED — HTTP 400 Bad Request** to an automated client. |

**Consequence:** five of the nine mandated sources yielded nothing this session. The WhatsApp,
Messenger and Instagram provider contracts in this repository therefore still rest on the evidence
already recorded in [`../research/provider-evidence.md`](../research/provider-evidence.md), not on
anything retrieved on 2026-09-09. Nothing in Milestone A depends on them; they matter to Milestone C,
and that milestone must re-attempt them from an interactive session or a rendered browser.

### Patterns newly adopted into Milestone A

| Observed pattern | Source | Where it lands in CONVO |
|---|---|---|
| The conversations list response carries **queue counts in `meta`** — `mine_count`, `unassigned_count`, `assigned_count`, `all_count` — alongside the page of results, rather than requiring separate count calls. | Chatwoot API [12] | CONVO's segment tabs already render counts beside each queue label; this confirms the counts belong in the *list* response envelope when the real endpoint lands in Milestone D, not in five extra round trips. Recorded as a contract decision, not yet an endpoint. |
| **`last_non_activity_message`** is a distinct field from `messages[]`: the row preview deliberately skips activity/system events and shows the last real message. | Chatwoot API [12] | Adopted as a rule for the queue row: the one-line preview never shows a system event. |
| **`can_reply`** travels on the conversation record itself, so a client knows the channel window is closed without a second call. | Chatwoot API [12] | Matches CONVO's existing `windowState` cue in the thread header and the blocked composer; confirms it belongs on the list record too. |
| Per-actor last-seen timestamps (`agent_last_seen_at`, `assignee_last_seen_at`, `contact_last_seen_at`) are separate fields — unread is per user, and the customer's read state is a different thing entirely. | Chatwoot API [12] | Convergent with `business-rules.md` §4; recorded because it independently confirms the three-dimension model in invariant I12. |
| The new-message indicator follows a **priority order — Mine > Team > Unassigned > All** — so a conversation's blue dot appears on exactly one queue, not on every queue that contains it. | respond.io [13] | Adopted as the rule for CONVO's unread dot. Without it, one unread conversation lights up five segments and the indicator stops meaning anything. |
| The blue dot **counts conversations, not messages**. | respond.io [13] | Adopted; CONVO's numeric unread pill on the row counts messages, and the segment dot counts conversations. The two are labelled differently for that reason. |
| Standard and Team inboxes refresh in real time; a **saved/custom view does not** — it shows a "Last updated X ago" banner with an explicit refresh control. | respond.io [13] | Adopted as the honest model for CONVO's stale/offline state: a saved view is a snapshot of a query, and pretending it is live is the kind of quiet lie this product avoids. Rendered today as the `offline` preview state. |
| The right-hand sidebar is **tabbed** — Contact details / Activities / Attachments / CRM — not one long scroll. | respond.io [13] | Recorded for the customer panel. CONVO's panel is currently sectioned rather than tabbed; tabs are the better fit once attachments and CRM carry real data (Milestone D). |
| The Attachments tab shows file name, type, size, sender and source channel, and can jump to the originating message. | respond.io [13] | Recorded as the attachment-panel contract for Milestone D. |
| WhatsApp onboarding is a **catalogue → Connect → eligibility checks → provider login → permission grant → select business portfolio and WABA → add/verify phone → review shared assets → Finish** sequence, and an incomplete setup surfaces as "Continue to feature setup" rather than success. | respond.io [14] | Recorded for Milestone C's Channels screen: the readiness states in `business-rules.md` §8 map onto this sequence, and "incomplete setup" is a real state a provider reports, not one we invent. |

### Patterns seen and deliberately rejected

- respond.io's **Collaborations** self-view and collaborator concept — CONVO has no collaborator in
  `business-rules.md`; adding a view for a concept the domain does not model would be theatre.
- respond.io's **Blocked Contacts inbox** and **Incoming Calls** tabs — no voice channel and no block
  list in scope for the live MVP.
- Chatwoot's `browser_language` / `referer` filter attributes — CONVO has no data behind them.

### What was NOT taken

No artwork, icon, illustration, logo, brand colour, typeface pairing, marketing copy or product
string was reused from any source above. Every icon in `apps/web/src/icons.ts` is drawn in-repo on a
24px stroke grid. The palette in `apps/web/src/theme.ts` is CONVO's own and was derived by contrast
arithmetic, not sampled from a screenshot. No searched screenshot is presented anywhere in this
repository as a licensed design asset.

---

## 6. Sources

1. respond.io — Inbox Overview. <https://respond.io/help/inbox/inbox-overview>
2. respond.io — Managing Conversations in Inbox. <https://respond.io/help/inbox/managing-conversations-in-inbox>
3. respond.io — Managing Custom Inboxes. <https://respond.io/help/inbox/custom-inbox>
4. Chatwoot — Conversations Filter API reference. <https://developers.chatwoot.com/api-reference/conversations/conversations-filter>
5. Chatwoot — public source, `advancedFilterItems/index.js`. <https://github.com/chatwoot/chatwoot/blob/develop/app/javascript/dashboard/components/widgets/conversation/advancedFilterItems/index.js>
6. Chatwoot — public source, `FilterOperatorTypes.js`. <https://github.com/chatwoot/chatwoot/blob/develop/app/javascript/dashboard/components/widgets/FilterInput/FilterOperatorTypes.js>
7. Chatwoot — public source, `ConversationBasicFilter.vue`. <https://github.com/chatwoot/chatwoot/blob/develop/app/javascript/dashboard/components/widgets/conversation/ConversationBasicFilter.vue>
8. Chatwoot — public source, `i18n/locale/en/advancedFilters.json` and `i18n/locale/en/chatlist.json`. <https://github.com/chatwoot/chatwoot/tree/develop/app/javascript/dashboard/i18n/locale/en>
9. Chatwoot — Conversation Filters (marketing page; fetch failed, search snippet only). <https://www.chatwoot.com/features/conversation-filters>
10. Chatwoot — How to use Conversation Filters (help centre; fetch failed). <https://www.chatwoot.com/hc/user-guide/articles/1677688192-how-to-use-conversation-filters>
11. Figma Community — Customer Support Chat Dashboard UI – SaaS Admin Panel (**403, not retrieved**). <https://www.figma.com/community/file/1514208352310179359/customer-support-chat-dashboard-ui-saas-admin-panel>
12. Chatwoot — Conversations List API reference. <https://developers.chatwoot.com/api-reference/conversations/conversations-list> (fetched 2026-09-09, HTTP 200)
13. respond.io — Getting Started with Inbox. <https://respond.io/help/inbox/getting-started-with-inbox> (fetched 2026-09-09, HTTP 200)
14. respond.io — WhatsApp Business Platform (API) Quick Start. <https://respond.io/help/whatsapp/whatsapp-api-quick-start> (fetched 2026-09-09, HTTP 200)
15. respond.io — Channels index. <https://respond.io/help/channels> (fetched 2026-09-09, HTTP 200)
16. Chatwoot help centre — Chatwoot 101 category. <https://www.chatwoot.com/hc/user-guide/en/categories/chatwoot-101> (**blocked**, connection timed out 2026-09-09)
17. Chatwoot — Conversation Filters feature page. <https://www.chatwoot.com/features/conversation-filters> (**blocked**, connection timed out 2026-09-09)
18. Meta via Postman — WhatsApp Cloud API. <https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api> (**blocked**, client-side rendered, no text served 2026-09-09)
19. Meta via Postman — Messenger Platform API. <https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api> (**blocked**, client-side rendered, no text served 2026-09-09)
20. Meta — Instagram API with Instagram Login, Messaging API. <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api> (**blocked**, HTTP 400 to an automated client, 2026-09-09)

---

## 7. Skills invoked for the Milestone A rebuild (2026-09-09)

Recorded because the task mandates them and because two of them do not mean, in this environment,
what their names suggest.

| Skill | What it actually provided here |
|---|---|
| `/design-systems` | Applied. Foundations → components → patterns layering, design-token naming and semantic aliasing, and the component state contract drove the five-layer stylesheet and the token module. |
| `/wireframing-prototyping` | Applied. Layout-contract and handoff discipline: the density numbers are treated as a specification with measurable acceptance rather than as a mood. |
| `/accessibility` | Applied (not mandated, but directly relevant). WCAG 2.1 AA criteria, landmark/heading/ARIA rules, focus management, contrast ratios and the 200%-zoom requirement are the source of `tests/e2e/a11y.spec.ts`. |
| `/web-research` | Applied. Its lean fetch-and-cite workflow produced §5a above, including the honest blocked-source table. |
| `/design` | Invoked. It is Claude Design's multi-artboard **canvas** tool: it produces a published mockup artifact. Its craft guidance was applied — settle one direction, lift exact values from the real source rather than from memory, flex/grid with `gap`, inline SVG icons, no AI-slop tropes. Its *output path* was deliberately not used: the master task forbids a mockup-only answer, and the deliverable for Milestone A is the running application plus its measured evidence. |
| `/product-polish` | Invoked. In this environment it is a **Blender** skill — it imports a `.glb` into Blender via an MCP addon on port 9876 and applies studio lighting for 3D product shots. It has no bearing on a CSS refactor and no Blender instance is running. Recorded as invoked-and-not-applicable rather than silently skipped. |
