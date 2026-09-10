-- 0018_work_routing
-- Moving a conversation between people, and the evidence that it moved.
--
-- Three acts, kept apart because merging them makes the audit trail useless in
-- exactly the argument it exists to settle (ADR-0017): a **claim** takes work
-- nobody holds, an **assignment** puts work on a named desk, and a **handoff**
-- asks a colleague who may decline. A fourth dimension — ADR-0008's bot-versus-
-- human ownership — lands here too, and shares nothing with the third but a
-- word we are careful not to overload.

-- ---------------------------------------------------------------------------
-- A name a human can be offered work by.
--
-- The schema has had no human-facing name at all: `users.email` is a LOGIN
-- identity, and an assignee picker that listed login addresses would leak one
-- person's credentials-adjacent identifier to every colleague who can assign.
--
-- It belongs to the MEMBERSHIP, not to the user: the same person can be
-- "Hana" at one company and "H. Abdullah" at another, and the name is
-- administered by the company that sees it. Backfilled from the local part of
-- the email so no row is left without one, and constrained so it cannot become
-- a second free-text field nobody bounds.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships ADD COLUMN display_name text;

UPDATE memberships m
   SET display_name = left(split_part(u.email, '@', 1), 120)
  FROM users u
 WHERE u.id = m.user_id AND m.display_name IS NULL;

-- Filled from the login identity when nobody supplied one, in a trigger rather
-- than at each insert site. A column default cannot do it — the value comes
-- from a join — and spreading the rule across the invitation path, the
-- bootstrap and every future caller is how one of them ends up creating a
-- member with no name and a picker with a blank row. An explicit name always
-- wins; this only fills a NULL.
CREATE FUNCTION memberships_default_display_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_name IS NULL THEN
    SELECT left(split_part(u.email, '@', 1), 120) INTO NEW.display_name
      FROM users u WHERE u.id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_display_name_default
  BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_default_display_name();

ALTER TABLE memberships
  ALTER COLUMN display_name SET NOT NULL,
  ADD CONSTRAINT memberships_display_name_ck
    CHECK (length(display_name) BETWEEN 1 AND 120);

-- ---------------------------------------------------------------------------
-- Bot-versus-human ownership (ADR-0008).
--
-- Modelled now even though no bot exists, because retrofitting it later would
-- mean re-touching the whole send path. `owner_version` is the fence: an AI
-- result produced before a takeover is re-checked against it at submission AND
-- again before dispatch, so a stale generation can never become a valid send
-- because a screen changed.
--
-- Backfilled to `human_active`, which is the truthful state of every
-- conversation in this build: people are working all of them.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN owner_state text NOT NULL DEFAULT 'human_active'
    CHECK (owner_state IN ('bot_active', 'handoff_pending', 'human_active', 'bot_paused')),
  ADD COLUMN owner_version integer NOT NULL DEFAULT 1 CHECK (owner_version > 0);

-- The ownership the send permit was issued under.
--
-- ADR-0008 requires an AI result to be re-checked against `owner_version` when
-- submitted AND again before dispatch. The second check needs to know what the
-- permit was granted under, so every accepted command records it. Nullable for
-- the rows written before this migration, and for a send addressed straight at
-- a connection with no conversation to own it.
ALTER TABLE outbound_messages ADD COLUMN permitted_owner_version integer
  CHECK (permitted_owner_version IS NULL OR permitted_owner_version > 0);

-- ---------------------------------------------------------------------------
-- Every routing and ownership fact, append-only.
--
-- One table rather than five near-identical ones, with a typed `act` so it is a
-- vocabulary and not a shapeless log. The runtime role holds SELECT and INSERT
-- and nothing else: an audit a service can rewrite cannot answer the question
-- it exists to answer.
--
-- `from_value` / `to_value` are text because the facts they carry are of
-- different kinds — a membership id, a priority word, an ownership state — and
-- three nullable typed column pairs would be three ways to record the same
-- sentence.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- Null only for a fact nobody caused: an offer that ran out of time.
  actor_membership_id uuid,
  act             text NOT NULL CHECK (act IN (
                    -- The four ways the assignee column changes …
                    'claim',
                    'assign',
                    'unassign',
                    'handoff',
                    -- … and the five ways an offer's own state changes.
                    'handoff_requested',
                    'handoff_accepted',
                    'handoff_declined',
                    'handoff_cancelled',
                    'handoff_expired',
                    'priority_changed',
                    'collaborator_added',
                    'collaborator_removed',
                    'owner_changed'
                  )),
  from_value      text,
  to_value        text,
  -- The conversation version this fact was decided against, so an audit reader
  -- can reconstruct which writes raced.
  at_version      integer NOT NULL CHECK (at_version > 0),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_audit_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_audit_actor_fk
    FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (actor_membership_id),
  CONSTRAINT conversation_audit_detail_ck CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX conversation_audit_conversation_idx
  ON conversation_audit (tenant_id, conversation_id, at DESC);

ALTER TABLE conversation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_audit
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON conversation_audit TO convo_app;

-- ---------------------------------------------------------------------------
-- Person-to-person handoff offers (ADR-0017).
--
-- An offer, not a transfer. While one is pending the current assignee is STILL
-- the assignee: a conversation with an unanswered request is not in limbo, and
-- somebody remains responsible for the customer.
--
-- `based_on_version` records the conversation version the offer was made
-- against. Acceptance is fenced on the version at the moment of acceptance, not
-- on this one — but an audit reader needs to know what the requester was
-- looking at.
--
-- `expires_at` is a stored instant swept durably. A browser timer may grey out
-- a button; it may never be what makes an offer expire.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  from_membership_id uuid NOT NULL,
  to_membership_id   uuid NOT NULL,
  state           text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  note            text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  based_on_version integer NOT NULL CHECK (based_on_version > 0),
  -- Who held the conversation when the offer was made. An offer says "take this
  -- from me"; if somebody has since moved it elsewhere, the premise is gone and
  -- accepting would take it from a third party who never agreed to anything.
  -- Not derivable from `based_on_version`, which also moves for a priority
  -- change that has nothing to do with who owns the work.
  based_on_assignee_membership_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  settled_at      timestamptz,
  settled_by_membership_id uuid,

  CONSTRAINT conversation_handoffs_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_handoffs_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_handoffs_from_fk
    FOREIGN KEY (tenant_id, from_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_handoffs_to_fk
    FOREIGN KEY (tenant_id, to_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_handoffs_based_on_assignee_fk
    FOREIGN KEY (tenant_id, based_on_assignee_membership_id)
    REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (based_on_assignee_membership_id),
  CONSTRAINT conversation_handoffs_settled_by_fk
    FOREIGN KEY (tenant_id, settled_by_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (settled_by_membership_id),
  -- Nobody hands a conversation to themselves. It is not a transfer, and the
  -- audit row it would produce says nothing happened.
  CONSTRAINT conversation_handoffs_distinct_ck CHECK (from_membership_id <> to_membership_id),
  CONSTRAINT conversation_handoffs_expiry_ck CHECK (expires_at > created_at),
  -- A pending offer has not been settled; a settled one has, by somebody or by
  -- the clock. Enforced here so no code path can leave a half-settled row.
  CONSTRAINT conversation_handoffs_settled_ck
    CHECK ((state = 'pending') = (settled_at IS NULL))
);

-- At most one live offer per conversation. A queue of competing offers makes
-- "who is being asked" stop having one answer, which is the single question the
-- feature exists to answer. A partial unique index rather than a read-then-write,
-- so two requesters racing produce one offer and one typed conflict.
CREATE UNIQUE INDEX conversation_handoffs_live_uq
  ON conversation_handoffs (tenant_id, conversation_id)
  WHERE state = 'pending';

CREATE INDEX conversation_handoffs_recipient_idx
  ON conversation_handoffs (tenant_id, to_membership_id)
  WHERE state = 'pending';

ALTER TABLE conversation_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_handoffs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_handoffs
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- UPDATE is granted because settling an offer is a state change on the offer
-- itself, guarded by `WHERE state = 'pending'`. The *evidence* that it was
-- settled goes to `conversation_audit`, which nothing can rewrite.
GRANT SELECT, INSERT, UPDATE ON conversation_handoffs TO convo_app;

-- ---------------------------------------------------------------------------
-- The expiry schedule.
--
-- Ids and times, and deliberately no RLS — exactly like `conversation_wakes`,
-- `outbox` and `channel_event_queue`. A sweeper has to ask "whose offer is
-- due?" *before* it has a company to set a context for, and the offer itself
-- carries a note somebody wrote about a customer, which stays behind RLS where
-- it belongs. Splitting the schedule from the content is what lets both be
-- true.
--
-- The row exists only while the offer is pending: settling one removes it, so
-- the sweep scans what is actually outstanding rather than the whole history.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_handoff_expiries (
  handoff_id      uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  expires_at      timestamptz NOT NULL,

  -- Cascades with the conversation, exactly like `conversation_wakes`. Without
  -- it the sweeper would have to reason about a due offer whose conversation is
  -- gone, which is a case that only exists because the schedule outlived it.
  CONSTRAINT conversation_handoff_expiries_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_handoff_expiries_handoff_fk
    FOREIGN KEY (tenant_id, handoff_id) REFERENCES conversation_handoffs (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_handoff_expiries_due_idx
  ON conversation_handoff_expiries (expires_at);

GRANT SELECT, INSERT, DELETE ON conversation_handoff_expiries TO convo_app;

COMMENT ON TABLE conversation_handoff_expiries IS
  'Due-times for pending person-to-person handoff offers (ADR-0017). Ids and times only, never the note. A browser timer may grey out a button; this is what actually expires an offer.';

-- ---------------------------------------------------------------------------
-- Manually invited collaborators, as intervals.
--
-- Deliberately NOT `conversation_participants`. That table records who actually
-- ACTED, is append-only by grant, and must never lose a row: a former assignee
-- who replied keeps read access to what they wrote, and erasing that to make a
-- reassignment look tidy would erase the authorship of real messages.
--
-- A collaborator is a different fact — somebody invited to help who may not have
-- said anything yet — and inviting them can be undone. Modelling it as an
-- interval means removal stops FUTURE access without rewriting the past: the
-- row stays, `removed_at` is set, and if they did act they are in
-- `conversation_participants` anyway and keep what that gives them.
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_collaborators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  added_by_membership_id uuid,
  removed_at      timestamptz,
  removed_by_membership_id uuid,

  CONSTRAINT conversation_collaborators_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_collaborators_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_collaborators_added_by_fk
    FOREIGN KEY (tenant_id, added_by_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (added_by_membership_id),
  CONSTRAINT conversation_collaborators_removed_by_fk
    FOREIGN KEY (tenant_id, removed_by_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (removed_by_membership_id),
  CONSTRAINT conversation_collaborators_interval_ck
    CHECK (removed_at IS NULL OR removed_at >= added_at)
);

-- One live collaboration per person per conversation; history unbounded behind
-- it, so somebody can be invited, removed and invited again without the second
-- invitation erasing the first.
CREATE UNIQUE INDEX conversation_collaborators_live_uq
  ON conversation_collaborators (tenant_id, conversation_id, membership_id)
  WHERE removed_at IS NULL;

CREATE INDEX conversation_collaborators_live_idx
  ON conversation_collaborators (tenant_id, conversation_id)
  WHERE removed_at IS NULL;

ALTER TABLE conversation_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_collaborators FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON conversation_collaborators
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON conversation_collaborators TO convo_app;

-- ---------------------------------------------------------------------------
-- The assignee list.
--
-- `conversations_unassigned_idx` from migration 0014 already covers the queue
-- read exactly — `WHERE assignee IS NULL AND status = 'open'`, ordered by
-- `waiting_since` — and is left alone.
--
-- The assignee read is not covered: `conversations_assignee_idx` stops at the
-- membership, and "this person's work" is ordered by `last_activity_at DESC`,
-- so every list still sorted. Replaced rather than duplicated, because two
-- indexes on the same predicate is a write cost for one read.
-- ---------------------------------------------------------------------------
DROP INDEX conversations_assignee_idx;

CREATE INDEX conversations_assignee_idx
  ON conversations (tenant_id, assignee_membership_id, last_activity_at DESC)
  WHERE assignee_membership_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The permission a handoff request needs (ADR-0017).
--
-- Not `conversation.assign`: business-rules.md §7 gives an Agent no authority to
-- reassign other people, and borrowing that key to let them ASK a colleague
-- would have handed every agent the authority Supervisor exists to hold.
-- Delegable — it moves no money, grants no permission and reaches no credential.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (key, description, delegable) VALUES
  ('conversation.handoff.request', 'Offer your own conversation to a named colleague', true);

-- The reference matrix every future tenant is seeded from.
INSERT INTO builtin_role_grants (role_key, permission_key, scope_level) VALUES
  ('owner',      'conversation.handoff.request', 'tenant'),
  ('admin',      'conversation.handoff.request', 'tenant'),
  ('supervisor', 'conversation.handoff.request', 'scoped'),
  ('agent',      'conversation.handoff.request', 'own');

-- And the tenants already provisioned, whose built-in roles were seeded from
-- that matrix before this key existed. Read from `builtin_role_grants` rather
-- than repeating the levels, so the two can never be seeded differently.
INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
SELECT r.tenant_id, r.id, g.permission_key, g.scope_level
  FROM roles r
  JOIN builtin_role_grants g ON g.role_key = r.key
 WHERE r.is_builtin AND g.permission_key = 'conversation.handoff.request'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Two more event types.
--
-- Separate types, not one "routing changed" event, for the same reason the feed
-- already separates notes from receipts: a subscriber who may only PREVIEW an
-- unclaimed conversation must be filterable by the event's own type before any
-- payload is read.
--
--   `conversation.handoff` — an offer between two named people. Internal, like a
--     note: an agent who may only preview has no business learning that
--     colleagues are negotiating who takes it.
--   `conversation.routing` — priority and collaborators. Priority is on the
--     queue card, so this one is projected rather than hidden.
-- ---------------------------------------------------------------------------
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_type_check;

ALTER TABLE realtime_events
  ADD CONSTRAINT realtime_events_type_check
  CHECK (type IN (
    'message.inbound',
    'message.delivery',
    'conversation.assigned',
    'conversation.state',
    'conversation.note',
    'conversation.handoff',
    'conversation.routing'
  ));
