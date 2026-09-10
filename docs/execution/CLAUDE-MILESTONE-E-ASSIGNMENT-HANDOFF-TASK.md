# Claude Code task — Milestone E: assignment, handoff and work routing

Continue inside `/Users/eyad/Downloads/convo` **without a trailing space**. The latest completed checkpoint is commit `2fe8d6d` (`Milestone D (slice 3): the conversation lifecycle, notes and read state`). Preserve it. Do not restart the application, rebuild the finished Inbox, or restore any deleted demo behavior.

Before editing, run:

```text
pwd
git status --short
git log --oneline -12
```

Read these sources in this order:

1. `docs/execution/current-task.md`, especially **Next task — Milestone E**.
2. `docs/product/business-rules.md`, especially §§3, 4, 4.1 and 7.
3. `docs/requirements/traceability.md`, especially CON-07, CON-08, IAM-11..IAM-13 and DEL-19..DEL-21.
4. `docs/adr/0008-ownership-and-handoff-barrier.md`.
5. `research/convo-2026-09-07/implementation-v2/MASTER-PROMPT.md`, especially §§3, 4, 6, 17, 18.1, 19 and 20.2.
6. `docs/api/operation-inventory.md`, `docs/api/openapi.v1.json`, `docs/database/erd.md` and `docs/testing/strategy.md`.
7. The actual conversation, authorization, realtime, People/Teams and Inbox code and tests.

Reconcile every statement below with the repository before writing code. If the ledger and code differ, trust observed code/test behavior, record the discrepancy, and repair the ledger. Do not silently widen or reduce scope.

## Current truth that must remain true

- The real Inbox, Contacts, lifecycle, notes, unread state and realtime client already use the server.
- A claim assigns an **unassigned** conversation to the caller, requires `conversation.claim`, and is fenced by the version shown on the queue card.
- A claim without a version is forbidden. Two claimers at one version produce exactly one winner and one typed `conversation_version_conflict`.
- Full conversation access is decided by permission key, current inbox/team scope and current assignment or recorded participation. Losing inbox access overrides both assignment and participation.
- An agent may preview only the closed queue-card projection before claim. The browser never receives a full conversation and hides it locally.
- `conversation.assigned` is already a durable realtime event whose visibility is recalculated per subscriber.
- Realtime events say what changed; the browser re-reads the owning endpoint. Do not patch authoritative conversation data from an event payload.
- `conversation_participants` records historical participation. A former assignee who acted in a conversation keeps permitted read access after reassignment, while inbox-scope removal removes it immediately.
- Lifecycle state, each person's read cursor, command state, delivery state and bot/human ownership are separate dimensions.
- Every tenant-owned row uses non-null `tenant_id`, composite tenant foreign keys, FORCE RLS and the non-owner runtime role.
- All UI mutations use CSRF, wait for the committed server response, show the server refusal and `request_id`, and never display success on click.
- Coverage is currently 100/100/100/100. Do not lower a threshold, add a broad exclusion, delete a meaningful assertion, or cover unreachable code artificially.
- Provider-live checks remain `blocked_no_asset`. This task needs no provider and must continue without credentials.

## Completion boundary

Complete the work-routing surface described in `current-task.md`: assignment to another person, explicit person-to-person handoff requests, priority and participant edits, their audit/realtime behavior, and the production Inbox UI for them.

Do **not** start campaigns, CRM, AI generation, labels, SLA, macros, search, draft persistence or provider HTTP clients in this task. Record those as later work without using them to leave this slice partially wired.

## 1. Define the three acts without overloading them

Implement three distinct business operations and keep their permissions and effects separate:

### Self-claim

Keep the existing operation and contract unchanged:

- only an unassigned conversation;
- target is always the current membership;
- requires `conversation.claim` on the conversation's current inbox/team scope;
- requires the exact conversation version the caller saw;
- one winner under concurrency.

### Direct assignment or reassignment

Add the operation already reserved by the inventory:

```text
POST /api/v1/tenants/{tenantId}/conversations/{conversationId}/assignments
```

It must:

- require `conversation.assign`, checked by permission key and effective resource scope, never by role name;
- accept an explicit target membership and the exact expected conversation version;
- support assigning an unassigned conversation and replacing an existing assignee;
- make the assignment, participation/audit decision, conversation version bump and durable realtime event one transaction;
- reject a stale version with `409 conversation_version_conflict` rather than silently taking work from somebody;
- reject cross-tenant, inactive, suspended or revoked targets;
- reject a target whose current grants and inbox/team scopes do not actually reach this conversation;
- re-check target eligibility inside the write transaction, even if the target was just returned by the directory;
- never accept `tenant_id`, actor identity, role name, permission flags or authority facts from the body;
- preserve the previous assignee's historical participation. Never delete action-derived participation to make reassignment look tidy.

Use a typed response and refusal vocabulary. A missing or foreign target must not become a tenant/membership enumeration oracle. Decide and document when the caller receives 404 versus 403/409 using the repository's existing concealment rules.

### Person-to-person handoff request

Add `/handoffs` operations from the master inventory. A handoff is an offer with a decision; it is **not** an immediate reassignment disguised by optimistic UI.

Required states and behavior:

- persist `pending`, `accepted`, `declined`, `cancelled` and `expired` with creator, intended recipient, timestamps, expiry and the conversation version the offer was based on;
- while pending, the current assignee remains the current assignee;
- acceptance atomically settles the offer and applies the reassignment against a valid fence;
- decline, cancel and expiry change no assignment;
- only the intended recipient may accept or decline; only an authorized creator may cancel;
- at most one live handoff request per conversation unless the documented business rule explicitly supports a queue of offers;
- reassigning, archiving, invalidating the target's access or creating a newer ownership decision makes an older pending offer unusable with a typed, visible result;
- a retry cannot create two live offers or apply the transfer twice;
- expiry must be derived from a stored instant and processed durably; browser timers are presentation only;
- every state change is audited in the same transaction as its effect.

Do not invent a permission by borrowing an unrelated one. Direct assignment must remain `conversation.assign`. If the current permission catalogue cannot express “an Agent may request a handoff from their own conversation without being allowed to directly reassign other people,” add a dedicated, narrowly scoped permission through a migration, domain catalogue, role matrix and mechanical drift tests. Document this business-rule clarification in an ADR addendum or a new ADR. Owner/Admin should receive tenant scope, Supervisor scoped reach, Agent own reach, and other built-in roles no grant unless the existing business rules provide one.

The person-to-person handoff record is **not** ADR-0008's `handoff_pending`. That state describes a bot-to-human send barrier. Do not reuse one state for two different facts.

## 2. Assignee directory based on effective access

Implement the inventory route:

```text
GET /api/v1/tenants/{tenantId}/directory/agents?inbox_id={id}&conversation_id={id}
```

The exact final query shape may be adjusted and recorded in `operation-inventory.md`, but the contract must let the server evaluate the real target conversation.

The result must:

- include active memberships only;
- include only people whose effective grants, inbox scope and team scope permit work on the target conversation;
- use an explicit allowlist of presentation fields: opaque membership ID, human-facing label and any deliberately implemented availability state;
- exclude roles, raw scopes, MFA state, security metadata and other People-admin fields;
- avoid reusing `GET /people`, which requires `member.manage` and exposes administrative data;
- reveal nothing across tenant or inaccessible inbox boundaries;
- be useful to a Supervisor who may assign work without permission to administer memberships.

The schema currently may not have a human display name. If so, add a constrained human-facing name with a safe fallback/migration rather than presenting internal IDs. Keep email a login identity; do not expose more of it than the product contract allows.

The assignment endpoint remains authoritative. A directory result is a suggestion from one instant, never authorization for a later write.

## 3. Priority and participants as audited domain operations

Implement priority and participant edits through a conversation service and documented API operations. Do not expose a generic patch that writes arbitrary conversation columns.

- Priority remains one of `low`, `normal`, `high`, `urgent` and every edit is version-fenced.
- Define which existing permission governs priority/routing changes and enforce its scope by key. Do not branch on role names.
- Record previous and new priority, actor, reason/source and timestamp in append-only audit evidence.
- Distinguish historical participants created by actual action from manually invited collaborators.
- Never delete or rewrite historical participation.
- If manual collaboration can be removed, model its active interval separately so removal stops future collaborator access without erasing history.
- Adding a participant is an access-granting action: validate the person's current membership, permission and inbox/team scope in the same transaction.
- Removing an assignee and removing a participant are different operations.
- All contested writes require the conversation version the operator saw and bump it exactly once per committed operation.

If the master requirement is ambiguous about a participant mutation, choose the smallest model that preserves auditability, historical authorship and least privilege, then record the decision. Do not implement a free-form membership-ID array on `conversations`.

## 4. Bot/human ownership foundation from ADR-0008

Close the model/enforcement portion of CON-07 without pretending an AI system exists.

- Add explicit `bot_active`, `handoff_pending`, `human_active`, `bot_paused` ownership state, a monotonically increasing `owner_version`, and append-only ownership transition evidence as ADR-0008 requires.
- Backfill existing conversations to the truthful non-bot state.
- Do not use bot/human `handoff_pending` for a person-to-person offer.
- Centralize the ownership predicate in the outbound permit path and bind it to `owner_version`, so a stale future AI result cannot become a valid human or provider send merely because the UI changed.
- Preserve current human replies. Do not accidentally block ordinary interactive sends, receipts, private notes or campaign-neutral contact activity.
- Do not add a fake bot, fake generation, fake transfer summary or a UI toggle that claims AI is active.
- Keep AI-specific OWN-02/OWN-03 live behavior and the in-flight bot barrier explicitly planned until an actual bot generation/send path exists. Mark only the model and enforcement evidence that this slice truly proves.

If completing this foundation safely requires an ADR-0008 clarification, write it before the migration and keep the original “no atomic recall after a provider accepted a request” rule unchanged.

## 5. Transactional persistence and audit

Use a new forward-only migration after `0017`; do not rewrite applied migrations.

At minimum model:

- assignment history or assignment events;
- time-bounded person-to-person handoff offers and their settlement;
- any separate manual-collaboration interval needed by the chosen participant behavior;
- bot/human owner state/version and append-only transition evidence;
- indexes and uniqueness constraints for the unassigned queue, assignee lists, live offers and expiry sweeps.

Every tenant-owned relationship uses a composite foreign key containing `tenant_id`. Enable and FORCE RLS. Grant the runtime role only the operations the service needs. Audit/event rows are append-only; the runtime role must not rewrite history. Back database constraints with integration tests through both the application role and the migration/schema owner where that difference matters.

For each mutation, commit the conversation change, history/audit row and `realtime_events` row together. Fault-injection tests must prove a late failure rolls the whole operation back rather than leaving assignment without audit or an event without assignment.

## 6. Realtime and immediate revocation

Use the existing `conversation.assigned` event and extend the typed payload only where necessary. Add separate event types only for facts that subscribers must authorize differently; update the database constraint, domain enum, OpenAPI schema and exhaustive tests together.

Required behavior:

- the new assignee sees the committed conversation after acceptance/assignment;
- the former assignee receives the assignment event if their prior participation allows it, then continues or loses access according to the server's normal authorization;
- an Agent reassigned away keeps read access to content they participated in while their inbox scope remains;
- removing that inbox scope makes HTTP and realtime access disappear without logout and within the documented revocation bound;
- an unassigned conversation returns only as a projected queue card to eligible viewers;
- somebody who has neither assignment, participation nor scoped supervisory access receives no conversation ID, count or event;
- the browser clears selected content and drafts when a re-read returns a permission loss. It must not leave another agent's timeline on screen from cache.

Test assignment versus claim, assignment versus assignment, handoff acceptance versus direct reassignment, expiry versus acceptance, and access revocation races with real PostgreSQL transactions. Each race must have a stated winner rule and no half-committed state.

## 7. Production Inbox UI

Extend the existing compact Inbox design; do not redesign Milestone A and do not add a second UI architecture.

Add:

- an accessible assignee control in the conversation header/details area;
- server-backed eligible-agent loading, empty, denied, stale and failure states;
- current assignee and clear unassigned state;
- direct assign/reassign controls only when the current principal can actually use them;
- handoff request, pending banner, recipient, expiry and accept/decline/cancel actions for the relevant person;
- priority edit with the four real values;
- participant/collaborator presentation and allowed edits;
- a clear “this conversation moved” state when access is lost;
- Arabic and English copy, RTL/LTR layout, Latin digits in both languages, keyboard operation, focus restoration and screen-reader announcements;
- light and dark theme coverage using the existing tokens.

Do not load the People admin screen to populate the control. Do not show fake availability, fake SLA, demo agent names, `setTimeout` success or local-only mutations. Use realistic deterministic fixtures only inside tests. A success toast appears after the committed response; a refusal stays beside the control that caused it and includes `request_id`.

Keep the conversation list and timeline compact at 1440×900 and 1366×768. The new controls must not enlarge the header/footer until only 3–4 messages are visible, reopen the permanently expanded sidebars, clip Arabic labels, or introduce horizontal page scrolling.

## 8. API and contract work

Update the pinned OpenAPI contract and bidirectional drift gate for every route and response. Include runtime validation, CSRF, error envelopes and optimistic-concurrency fields.

At minimum document and implement:

- assignee directory;
- direct assignment/reassignment;
- create/list/read or relevant handoff offers;
- accept, decline and cancel handoff;
- priority mutation;
- participant/collaborator mutation if supported by the chosen model.

Keep route names consistent with the master inventory unless a concrete REST/transaction reason requires a deviation. Record every intentional deviation in `operation-inventory.md`; do not silently invent a second spelling.

## 9. Required tests

Add meaningful unit, property, PostgreSQL integration, contract, security, E2E, accessibility and visual coverage.

The suite must prove at least:

1. Owner/Admin tenant assignment, Supervisor assignment only inside scope, Agent denied direct assignment.
2. An eligible target can be assigned; inactive, revoked, foreign-tenant and out-of-scope targets cannot.
3. Two direct assignments using one version have one winner.
4. Claim versus direct assignment at one version has one winner and no silent takeover.
5. A pending handoff does not change the assignee.
6. Only the named recipient accepts/declines; only the allowed creator cancels.
7. Accept happens once; decline/cancel/expiry never assigns; stale offers cannot later assign.
8. Reassignment or archival invalidates an old offer safely.
9. A repeated request or network retry cannot duplicate the offer, audit or assignment.
10. Assignment/audit/realtime roll back together under an injected late failure.
11. Former assignee participation survives reassignment; inbox-scope removal overrides it for both HTTP and realtime.
12. The directory contains only active, actually eligible people and exposes only allowlisted fields.
13. Priority is validated, version-fenced and audited.
14. Historical participation cannot be erased through the collaboration API.
15. Cross-tenant guessed IDs never reveal or link data, including through FK mistakes or socket events.
16. Realtime moves cards between Unassigned/My/allowed views without exposing a private timeline.
17. A reassigned-away open screen reauthorizes and clears inaccessible content.
18. Every UI mutation stays busy with no success state until the server commits, and renders the exact typed refusal plus `request_id` on failure.
19. Arabic/English keyboard and screen-reader flows work at both existing desktop viewports; long names do not clip; dark/light themes pass WCAG 2.1 AA or the repository's stronger existing target.
20. Existing claim, lifecycle, reply, note, read-cursor, delivery and realtime tests remain green.

Do not make tests pass by weakening assertions or encoding implementation trivia. Delete truly unreachable branches where the domain makes them impossible; otherwise test the user-visible or security-significant behavior.

## 10. Gates and evidence

Run the full repository sequence after the slice is implemented:

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:coverage
pnpm test:contracts
pnpm test:security
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

Keep `test:mutation`, `test:load:target` and `test:recovery` honest. Run any deterministic local portion that is now available; otherwise preserve their exact `not_run` or `blocked_env` reason. Do not label an unavailable environment as a pass.

Update:

- `docs/execution/current-task.md`
- `docs/requirements/traceability.md`
- `docs/product/business-rules.md` only if the clarified permission/routing rule requires it, with an ADR
- `docs/api/openapi.v1.json`
- `docs/api/operation-inventory.md`
- `docs/database/erd.md`
- `docs/testing/strategy.md` if the test contract changed
- `README.md`

The completion report must state exact changed behavior, migrations, routes, permission decisions, race outcomes, commands, exit codes and test counts. Separate implemented behavior, automated evidence and blocked external checks. Name every remaining gap plainly and set the next unblocked task.

Start with the domain contract and migration, then implement direct assignment end to end, then the assignee directory and UI, then handoff offers, priority/participants, bot/human ownership foundation, realtime races and the full gates. Continue automatically through this entire slice. Do not stop at a design note, schema only, backend-only route, local mock, or visually complete control with no server effect.
