-- 0016_contacts
-- Who the customer is, how we reach them, and what they have agreed to.
--
-- Three tables and one rule that shapes all of them: **an identity is scoped**.
-- A WhatsApp number, a page-scoped Messenger id and an Instagram-scoped id are
-- three different identities that may or may not belong to one person, and this
-- schema refuses to guess. Nothing here infers a link from a similar name, a
-- matching username or a phone number that looks the same with a different
-- country prefix (CT-03). Merging is a reviewed act, and it is not built yet —
-- so what exists is the honest shape it will need, not a placeholder that
-- silently merges today.

-- ---------------------------------------------------------------------------
-- The person.
--
-- Deliberately thin. A contact is an internal identity that other things hang
-- off; the channel-specific facts live on the identity rows, and business
-- fields live in `attributes` rather than as columns, because every company
-- means something different by "grade", "branch" or "plan".
--
-- `display_name` is what an agent sees and may correct. It is **not** an
-- identity: correcting it links nothing and unlinks nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- A deleted contact keeps its row: a conversation that referenced it must
  -- still render, and a deletion that erased history would erase the evidence
  -- of what was said to whom.
  deleted_at   timestamptz,

  CONSTRAINT contacts_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contacts_attributes_ck CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE INDEX contacts_name_idx ON contacts (tenant_id, display_name);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON contacts TO convo_app;

-- ---------------------------------------------------------------------------
-- How we reach them, and when that was true.
--
-- `scope_id` is the channel connection the identity is meaningful in. A
-- Messenger id is page-scoped: the same person messaging two pages is two
-- identities, and treating them as one would be an inference this schema
-- refuses to make (CT-02, CT-03).
--
-- Rotation **closes an interval and opens a new one** rather than overwriting a
-- column. A number reassigned to somebody else is the case that matters: the
-- messages sent to it before the reassignment belong to the person who held it
-- then, and an overwrite would silently re-attribute them.
-- ---------------------------------------------------------------------------
CREATE TABLE contact_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('whatsapp', 'messenger', 'instagram', 'web_chat', 'custom')),
  -- The connection the external id is scoped to.
  scope_id    uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  -- How we learned it: which event, which actor, which import.
  provenance  jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT contact_identities_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_identities_contact_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_identities_scope_fk
    FOREIGN KEY (tenant_id, scope_id) REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_identities_interval_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT contact_identities_provenance_ck CHECK (jsonb_typeof(provenance) = 'object')
);

-- One *live* identity per scoped external id. History is unbounded; the present
-- is not.
CREATE UNIQUE INDEX contact_identities_live_uq
  ON contact_identities (tenant_id, kind, scope_id, external_id)
  WHERE valid_to IS NULL;

CREATE INDEX contact_identities_contact_idx ON contact_identities (tenant_id, contact_id);

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contact_identities
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON contact_identities TO convo_app;

-- ---------------------------------------------------------------------------
-- What they agreed to, as evidence.
--
-- Append-only: no UPDATE and no DELETE is granted. A consent record is a claim
-- about a moment — who said what, through which channel, for which purpose, on
-- whose word — and a system that can edit it cannot be used to answer the
-- question it exists to answer (CT-06).
--
-- Withdrawal is a **new row**, not a change to the old one. The current state
-- is the newest row per (contact, channel, purpose), which is why `recorded_at`
-- is part of the index rather than a `current` flag somebody has to maintain.
--
-- Suppression is *not* here: it lives in `channel_suppressions`, is keyed by
-- identity rather than by contact, and wins over anything in this table (CT-08).
-- Keeping them apart is what makes "a suppression survives a contact merge, a
-- deletion and a CRM import" true rather than hopeful.
-- ---------------------------------------------------------------------------
CREATE TABLE consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('whatsapp', 'messenger', 'instagram', 'web_chat', 'custom')),
  purpose    text NOT NULL CHECK (purpose IN ('service', 'marketing')),
  state      text NOT NULL CHECK (state IN ('granted', 'withdrawn')),
  -- How it was obtained. `customer_message` is the customer writing to us;
  -- `import` can never mean opt-in on its own (CT-07), which the service
  -- enforces by refusing to record a grant from an import.
  source     text NOT NULL CHECK (source IN ('customer_message', 'agent_recorded', 'import', 'web_form')),
  proof_ref  text,
  actor_membership_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consents_contact_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT consents_actor_fk
    FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (actor_membership_id)
);

CREATE INDEX consents_current_idx
  ON consents (tenant_id, contact_id, channel, purpose, recorded_at DESC);

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON consents TO convo_app;

-- ---------------------------------------------------------------------------
-- The conversation's contact.
--
-- Nullable, and resolved when the customer's first message is normalized. A
-- conversation opened by an outbound template to a number nobody has heard from
-- has no contact yet, and inventing one from a phone number would be the
-- inference this schema exists to refuse.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN contact_id uuid,
  ADD CONSTRAINT conversations_contact_fk
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
    ON DELETE SET NULL (contact_id);

CREATE INDEX conversations_contact_idx ON conversations (tenant_id, contact_id)
  WHERE contact_id IS NOT NULL;
