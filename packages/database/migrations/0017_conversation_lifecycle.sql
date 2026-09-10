-- 0017_conversation_lifecycle
-- The lifecycle table of MASTER-PROMPT §18.1, given somewhere to live.
--
-- Until now a conversation had three states and one way in and out of each.
-- §18.1 specifies five states and eleven transitions, and three of them need
-- storage that does not exist yet: a waiting reason, a durable versioned wake,
-- and a reporting episode that survives a reopen.
--
-- The shape of the whole thing is one idea: **a conversation's state is a
-- consequence, not a field somebody sets.** Every column added here exists to
-- make one row of that table decidable in SQL rather than hopeful in a handler.

-- ---------------------------------------------------------------------------
-- The two missing states.
--
-- `pending` is waiting on the customer; `archived` is history. They are not the
-- same as `resolved`: a resolved thread is the one a new inbound reopens, and
-- an archived one is never mutated as if it were active — a message arriving
-- after archival opens a NEW thread and preserves the link to the old.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('open', 'pending', 'snoozed', 'resolved', 'archived'));

-- The identity is held until archival, not until resolution. §18.1 allows at
-- most one NON-ARCHIVED conversation per (tenant, inbox, identity); making the
-- index partial is what lets an archived thread keep its row while the customer
-- writes again and gets a new one.
ALTER TABLE conversations DROP CONSTRAINT conversations_identity_uq;

CREATE UNIQUE INDEX conversations_live_identity_uq
  ON conversations (tenant_id, connection_id, peer_identity)
  WHERE status <> 'archived';

-- ---------------------------------------------------------------------------
-- Waiting, sleeping, resolving, archiving.
--
-- `snooze_timezone` is stored beside `snoozed_until` and is not redundant with
-- it. The instant says when the job fires; the IANA zone says what the operator
-- MEANT. "Tomorrow morning" is a question about their calendar, and an
-- installation that kept only the instant cannot re-derive the intent after a
-- DST change or explain the choice to anyone afterwards (CON-03).
--
-- `wake_version` is the fence. Re-snoozing bumps it, so a wake job already in
-- flight for the old time finds a version that no longer matches and does
-- nothing. Without it the first snooze fires at its original time and wakes a
-- conversation the operator deliberately pushed further out.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN pending_reason  text CHECK (pending_reason IS NULL OR length(pending_reason) BETWEEN 1 AND 500),
  ADD COLUMN pending_since   timestamptz,
  ADD COLUMN snoozed_until   timestamptz,
  ADD COLUMN snooze_timezone text CHECK (snooze_timezone IS NULL OR length(snooze_timezone) BETWEEN 1 AND 80),
  ADD COLUMN wake_version    integer NOT NULL DEFAULT 0 CHECK (wake_version >= 0),
  ADD COLUMN resolved_at     timestamptz,
  ADD COLUMN resolution      text CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 120),
  ADD COLUMN archived_at     timestamptz,
  -- A snooze without a wake time, or a wake time on a conversation that is not
  -- snoozed, are both states the sweeper cannot act on sensibly. Refuse them
  -- here rather than discovering them in a worker.
  ADD CONSTRAINT conversations_snooze_ck CHECK (
    (status = 'snoozed') = (snoozed_until IS NOT NULL)
    AND (snoozed_until IS NULL) = (snooze_timezone IS NULL)
  );

COMMENT ON COLUMN conversations.snooze_timezone IS
  'The IANA zone the wake time was chosen in. Kept beside the instant because the instant cannot answer what the operator meant.';
COMMENT ON COLUMN conversations.wake_version IS
  'Bumped on every snooze. A wake job carrying an older version is a no-op, which is how re-snoozing invalidates the job already scheduled.';

-- ---------------------------------------------------------------------------
-- The durable wake job.
--
-- CON-03 asks for a durable **versioned wake job**, and this is it: a row per
-- snoozed conversation carrying when to wake it and which snooze it belongs to.
--
-- It is a queue rather than a scan of `conversations` for the same reason
-- `outbox` and `channel_event_queue` are queues: a sweeper has to find work
-- **across companies**, and `conversations` is under FORCE RLS where a query
-- with no tenant context correctly sees nothing. The alternative — running the
-- sweeper only for companies that happen to have other traffic — is how a
-- snoozed conversation in a quiet company never wakes at all.
--
-- Like the other worker queues it holds **no content**: an id, a company, a
-- time and a version. Nothing here says who the customer is or what was said.
--
-- Re-snoozing REPLACES the row (`ON CONFLICT DO UPDATE`) and bumps the version,
-- so the job for the earlier time stops existing rather than racing the new
-- one. The version is the second line of defence for a job already in flight.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_wakes (
  conversation_id uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  wake_at         timestamptz NOT NULL,
  wake_version    integer NOT NULL CHECK (wake_version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_wakes_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_wakes_due_idx ON conversation_wakes (wake_at);

-- Deliberately no RLS, exactly like `outbox` and `channel_event_queue`: this is
-- a worker's schedule, not a tenant's data, and a sweeper must be able to ask
-- "whose wake is due?" before it has a company to set a context for.
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_wakes TO convo_app;

COMMENT ON TABLE conversation_wakes IS
  'Durable versioned wake jobs (CON-03). Ids and times only, never content. Re-snoozing replaces the row and bumps the version, so an in-flight job for the old time is a no-op.';

-- ---------------------------------------------------------------------------
-- Reporting episodes.
--
-- A reopened conversation starts a NEW episode and the original's metrics are
-- retained (CON-04). Reusing the first episode would date the second issue's
-- first-response clock from the first issue's first message, which makes every
-- resolution-time report a lie — and a quiet one, because the number still
-- looks like a number.
--
-- The episode is a row rather than a set of columns on the conversation for the
-- same reason: columns would be overwritten by the reopen, and the history is
-- exactly what must survive it.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_episodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- 1, 2, 3 … within the conversation. Gapless and meaningful to a human
  -- reading a report; the uuid is for joins.
  seq             integer NOT NULL CHECK (seq > 0),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  -- Why this episode exists. `outbound_contact` is §18.1's last row: a campaign
  -- message to somebody with no active thread records outbound activity and
  -- does NOT open a support episode the customer never started.
  opened_by       text NOT NULL CHECK (opened_by IN ('customer_inbound', 'agent_reopen', 'outbound_contact')),
  -- The customer's first message of THIS episode, and the first human reply to
  -- it. Both nullable: an episode that nobody has answered yet is the case the
  -- first-response report exists to find.
  first_inbound_at  timestamptz,
  first_response_at timestamptz,
  closed_at       timestamptz,
  resolution      text CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 120),

  CONSTRAINT conversation_episodes_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_episodes_seq_uq UNIQUE (tenant_id, conversation_id, seq),
  CONSTRAINT conversation_episodes_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_episodes_order_ck
    CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE INDEX conversation_episodes_open_idx
  ON conversation_episodes (tenant_id, conversation_id, seq DESC);

ALTER TABLE conversation_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_episodes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_episodes
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: an episode is the evidence a report is computed from, and a report
-- that can be changed by deleting its inputs answers nothing.
GRANT SELECT, INSERT, UPDATE ON conversation_episodes TO convo_app;

-- ---------------------------------------------------------------------------
-- Private notes.
--
-- A note is NOT a message. It never enters `outbound_messages`, it has no
-- provider, no delivery state and no window, and nothing here can put it on a
-- wire. That is a property of where it is stored, not of a flag somebody
-- remembered to check.
--
-- Edits and deletions leave a marker rather than removing the row (§19: "edited
-- /deleted marker and audit"). A note that vanished without trace is a note
-- somebody can deny having written.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- Who wrote it. Nullable only because a membership can be removed, and losing
  -- the note with the person would lose the record of what was said.
  author_membership_id uuid,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT conversation_notes_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_notes_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_notes_author_fk
    FOREIGN KEY (tenant_id, author_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (author_membership_id)
);

CREATE INDEX conversation_notes_thread_idx
  ON conversation_notes (tenant_id, conversation_id, created_at DESC);

ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_notes
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- UPDATE, but no DELETE: editing sets `edited_at` and deleting sets
-- `deleted_at`, and both keep the row.
GRANT SELECT, INSERT, UPDATE ON conversation_notes TO convo_app;

-- ---------------------------------------------------------------------------
-- The read cursor.
--
-- Unread is a fact about a PERSON, not a badge the browser maintains: §18.1
-- requires each user's own last-visible-committed-message cursor, and reading a
-- conversation updates only that user's row.
--
-- This is not a receipt and must never be folded into one. An agent reading a
-- customer's message is not the customer reading ours; storing them in one
-- place is how a company ends up telling a customer their message was seen
-- because a colleague opened the thread.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_reads (
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  -- The newest committed activity this person has seen. Compared against
  -- `conversations.last_activity_at`, so it needs no per-message bookkeeping.
  read_through    timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, conversation_id, membership_id),
  CONSTRAINT conversation_reads_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_reads_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_reads FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_reads
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_reads TO convo_app;

COMMENT ON TABLE conversation_reads IS
  'Per-person read cursor. Never a provider receipt: an agent reading a customer message is not the customer reading ours.';

-- ---------------------------------------------------------------------------
-- A note is an entity of its own on the feed.
--
-- Not a `message` and not a `conversation`: a subscriber authorized for
-- receipts and not for notes must be filterable by the event's own columns,
-- before anything reads the payload. Folding notes into `message` would make
-- that filter a payload inspection, which is exactly the shape of mistake the
-- projection rules exist to prevent (DEL-19, IAM-11).
-- ---------------------------------------------------------------------------
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_entity_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_entity_type_check
  CHECK (entity_type IN ('conversation', 'message', 'note'));
