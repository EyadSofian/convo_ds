# ADR-0019 — Inbox history is excluded, and campaign attribution binds once

- **Status:** accepted
- **Date:** 2026-09-22
- **Phase gate:** Inbox product experience and campaign attribution
- **Requirement IDs:** CON-01, CON-03, CAMP-REPORTING

## Context

An archived conversation is immutable historical evidence. It is not an active
Inbox state: a later customer message creates a new conversation for the same
identity. Campaign dispatches, meanwhile, must not create an active
conversation merely so a report can claim that a campaign reached one.

The readable Inbox is cursor-paged and refreshed from realtime events. A cursor
is bound to the query snapshot that issued it, so mixing an old continuation
with a newer first page could duplicate or skip a conversation.

## Decision

- **Archived conversations are excluded from normal Inbox queries.** There is
  no `archived` status filter in the operator Inbox. History is reached from a
  contact/conversation context, not mixed into active work queues.
- **Search is server-side, debounced, and ephemeral.** It composes with the
  active typed filters but is deliberately not written to the URL. Reloadable
  routes retain scope, sort and filters only; an in-progress search draft
  survives ordinary UI re-renders until its 250 ms debounce commits.
- **Load more appends one cursor page with ID de-duplication.** A realtime
  refresh replaces the list with the first page and discards any previously
  accumulated continuation; the response's new cursor is the only cursor that
  may be used afterwards.
- **Campaign sends write an attribution row, never a conversation.** The row
  records tenant, campaign, execution, recipient, outbound message, connection,
  peer identity and send time. If a live conversation exists at dispatch it is
  bound immediately. Otherwise the first later customer-inbound conversation
  for the same tenant, connection and identity binds all eligible unbound rows.
  Eligibility starts after the most recent archived conversation and ends at
  the new conversation's creation time. This makes attribution boundary-driven
  rather than name-driven and prevents an old archived thread from absorbing a
  new response.
- **Binding is one way.** Identity evidence is immutable; an unbound row may
  become bound exactly once. Campaign filtering is by `campaign_id`, never by
  a mutable campaign name.

## Consequences

- Operators do not accidentally treat historical threads as work to claim.
- The campaign list reports attributable conversations without fabricating
  customer activity or changing lifecycle/SLA state.
- A realtime update can make a loaded page shorter or re-ordered. This is
  intentional: correctness beats a stale infinite-scroll snapshot.
- Label `in` semantics are explicit in the Inbox: all selected labels
  must be present. `not_in` means none are present.

## Alternatives rejected

- **Include archive as a regular Inbox status.** Rejected: it makes history
  look actionable and conflicts with archival immutability.
- **Create a conversation for each outbound campaign send.** Rejected: it
  would create false customer work, distort SLA and make empty outreach look
  like a response.
- **Bind attribution by campaign name or the next conversation regardless of
  archival boundary.** Rejected: names change and an old thread can otherwise
  receive evidence belonging to a later customer interaction.
- **Continue old cursor pages after realtime replacement.** Rejected: cursors
  are opaque positions in a particular ordered result, not durable offsets.

## How this is verified

- Integration coverage proves campaign planning creates an unbound attribution
  with no conversation, then a customer inbound binds it and an Inbox
  `campaign_id` query finds that conversation.
- Migration tests apply the attribution table, RLS policy, immutable binding
  trigger and indexes from a clean database.
- Unit coverage proves the SQL compiler uses a parameterized attribution
  predicate, label `ALL` semantics and typed custom-field comparisons.
- Browser unit coverage proves the Inbox obtains named picker values rather
  than accepting raw IDs, appends cursor pages safely, and refreshes the
  server-owned first page after a realtime event.
- Metadata measurement is structural and integration-tested: before this
  decision a 50-row page made one labels query and one custom-fields query per
  row (**100 metadata reads**). The page now calls `readMetadataBatch` once,
  which performs exactly **two** metadata reads for 50 IDs; the integration test
  counts those two queries against PostgreSQL.
