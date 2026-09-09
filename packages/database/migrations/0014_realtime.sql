-- 0014_realtime
-- Conversations, and the durable event feed a realtime subscriber reads.
--
-- Two things are built here, and the order matters.
--
-- **Conversations** give the authorization terms a subscription is decided
-- against. Until now a "conversation" was an implicit pair — a connection and a
-- peer identity — which is enough to order dispatch and not enough to answer
-- "may this person see this?". Inbox, team, assignee and participation are the
-- terms `authorize` already narrows on (I3), so they have to exist as columns
-- before a socket can be authorized against them.
--
-- **`realtime_events`** is an append-only, per-company, gapless log. It is
-- written in the same transaction as the effect it describes (DEL-07), so a
-- subscriber that reads it is reading committed truth rather than a hopeful
-- broadcast that may not have happened. The broker is still the transport
-- (ADR-0004); this is the source of order and the source of catch-up.

-- ---------------------------------------------------------------------------
-- Conversations.
--
-- A connection **is** an inbox in this build: a WhatsApp line, a Messenger
-- page, a website widget. `membership_scopes.scope_type = 'inbox'` names one of
-- these ids, which is what makes "an agent may work the enrollment line and not
-- the billing line" a database fact rather than a UI convention.
--
-- `version` is the claim's fence. business-rules.md §4.1 requires an atomic,
-- version-checked claim with exactly one winner; the loser is told so with a
-- typed conflict rather than silently overwriting the winner.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  peer_identity text NOT NULL CHECK (length(peer_identity) BETWEEN 1 AND 256),
  -- Routing scope. Null while no routing rule has claimed it: a conversation
  -- with no team is reachable through an inbox grant alone, which is exactly
  -- how a small company with one queue works.
  team_id       uuid,
  -- Null is the whole point of the Unassigned queue.
  assignee_membership_id uuid,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'snoozed', 'resolved')),
  priority      text NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- When the customer started waiting for a human. Cleared on claim, set again
  -- by the next inbound message.
  waiting_since   timestamptz,
  last_inbound_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversations_tenant_id_uq UNIQUE (tenant_id, id),
  -- One conversation per customer per inbox. The same pair the dispatch gate
  -- serializes on, now with an identity of its own.
  CONSTRAINT conversations_identity_uq UNIQUE (tenant_id, connection_id, peer_identity),
  CONSTRAINT conversations_connection_fk
    FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id)
    ON DELETE CASCADE,
  -- Deleting a team must not delete its conversations, and must not be able to
  -- null a tenant either: the column list is what keeps `SET NULL` honest.
  CONSTRAINT conversations_team_fk
    FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id)
    ON DELETE SET NULL (team_id),
  CONSTRAINT conversations_assignee_fk
    FOREIGN KEY (tenant_id, assignee_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (assignee_membership_id)
);

CREATE INDEX conversations_unassigned_idx
  ON conversations (tenant_id, connection_id, waiting_since)
  WHERE assignee_membership_id IS NULL AND status = 'open';

CREATE INDEX conversations_assignee_idx
  ON conversations (tenant_id, assignee_membership_id)
  WHERE assignee_membership_id IS NOT NULL;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON conversations TO convo_app;

-- ---------------------------------------------------------------------------
-- Participation.
--
-- An agent who replied and was later reassigned keeps read access to what they
-- wrote (business-rules.md §4.1), so participation is recorded rather than
-- inferred from the current assignee. Losing inbox access still overrides it —
-- `authorize` checks scope before ownership, and this table cannot change that.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_participants (
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  first_acted_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, conversation_id, membership_id),
  CONSTRAINT conversation_participants_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_participants_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_participants
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON conversation_participants TO convo_app;

-- ---------------------------------------------------------------------------
-- The per-company event counter.
--
-- A `bigserial` would be cheaper and wrong. Sequence values are handed out
-- before commit and are not returned in commit order, so a subscriber polling
-- "everything after 41" can read 42 while 41 is still uncommitted — and never
-- see 41 again. That is a silently lost event, which is the one failure a
-- realtime feed may not have.
--
-- A counter row is taken under a row lock held to commit, so numbers are dense
-- and issued in the order transactions commit. The cost is that two events for
-- the *same company* serialize at this row; that is a deliberate trade, because
-- a gapless sequence is what lets a reconnecting client prove it missed
-- nothing (DEL-20).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_event_sequences (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  next_seq  bigint NOT NULL DEFAULT 1 CHECK (next_seq > 0)
);

ALTER TABLE tenant_event_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_event_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_event_sequences
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON tenant_event_sequences TO convo_app;

-- ---------------------------------------------------------------------------
-- The event feed.
--
-- Append-only: no UPDATE and no DELETE is granted to the runtime role. An event
-- is a statement that something happened, and editing one afterwards would make
-- the feed unable to answer the only question it exists for.
--
-- The authorization terms are **columns**, not payload fields. A subscriber's
-- visibility is decided from `connection_id`, `team_id` and
-- `assignee_membership_id` before the payload is looked at, so a projection can
-- never be defeated by a payload that happens to contain more than it should.
--
-- DEL-19: every row carries `schema_version`, its own `id`, the entity it is
-- about with that entity's version, and the scope it belongs to.
-- ---------------------------------------------------------------------------
CREATE TABLE realtime_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  seq             bigint NOT NULL CHECK (seq > 0),
  schema_version  integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  -- Separate types, not one "changed" event with a discriminator inside the
  -- payload: a subscriber authorized for delivery receipts and not for notes
  -- must be filterable without reading either.
  type            text NOT NULL CHECK (type IN (
                    'message.inbound',
                    'message.delivery',
                    'conversation.assigned',
                    'conversation.state',
                    'conversation.note'
                  )),
  entity_type     text NOT NULL CHECK (entity_type IN ('conversation', 'message')),
  entity_id       uuid NOT NULL,
  entity_version  integer NOT NULL CHECK (entity_version > 0),

  conversation_id uuid NOT NULL,
  connection_id   uuid NOT NULL,
  team_id         uuid,
  assignee_membership_id uuid,

  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT realtime_events_seq_uq UNIQUE (tenant_id, seq),
  CONSTRAINT realtime_events_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX realtime_events_feed_idx ON realtime_events (tenant_id, seq);

ALTER TABLE realtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON realtime_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON realtime_events TO convo_app;
