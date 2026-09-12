-- 0019_metadata_catalogue
-- Tenant labels and typed business fields. Original values remain untouched;
-- normalized text exists only beside them for bounded, parameterized search.

ALTER TABLE contacts
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE contacts
  ADD COLUMN search_name text NOT NULL DEFAULT '';

-- Existing rows receive a conservative representation. New writes use the
-- domain normalizer, which is Unicode-aware even when the PostgreSQL test
-- cluster deliberately runs SQL_ASCII.
UPDATE contacts SET search_name = lower(trim(display_name));

DROP INDEX contacts_name_idx;
CREATE INDEX contacts_name_idx ON contacts (tenant_id, search_name, id);

CREATE TABLE labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  color       text NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labels_tenant_id_uq UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX labels_active_name_uq ON labels (tenant_id, lower(name))
  WHERE state = 'active';

CREATE TABLE conversation_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  conversation_id uuid NOT NULL,
  label_id    uuid NOT NULL,
  assigned_by_membership_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_by_membership_id uuid,
  removed_at  timestamptz,
  CONSTRAINT conversation_labels_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_labels_label_fk FOREIGN KEY (tenant_id, label_id)
    REFERENCES labels (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_labels_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (assigned_by_membership_id),
  CONSTRAINT conversation_labels_removed_by_fk FOREIGN KEY (tenant_id, removed_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (removed_by_membership_id),
  CONSTRAINT conversation_labels_interval_ck CHECK (removed_at IS NULL OR removed_at >= assigned_at)
);

CREATE UNIQUE INDEX conversation_labels_live_uq
  ON conversation_labels (tenant_id, conversation_id, label_id) WHERE removed_at IS NULL;
CREATE INDEX conversation_labels_filter_idx
  ON conversation_labels (tenant_id, label_id, conversation_id) WHERE removed_at IS NULL;

CREATE TABLE contact_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  label_id    uuid NOT NULL,
  assigned_by_membership_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_by_membership_id uuid,
  removed_at  timestamptz,
  CONSTRAINT contact_labels_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_labels_label_fk FOREIGN KEY (tenant_id, label_id)
    REFERENCES labels (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_labels_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (assigned_by_membership_id),
  CONSTRAINT contact_labels_removed_by_fk FOREIGN KEY (tenant_id, removed_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (removed_by_membership_id),
  CONSTRAINT contact_labels_interval_ck CHECK (removed_at IS NULL OR removed_at >= assigned_at)
);

CREATE UNIQUE INDEX contact_labels_live_uq
  ON contact_labels (tenant_id, contact_id, label_id) WHERE removed_at IS NULL;
CREATE INDEX contact_labels_filter_idx
  ON contact_labels (tenant_id, label_id, contact_id) WHERE removed_at IS NULL;

CREATE TABLE custom_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  target      text NOT NULL CHECK (target IN ('contact', 'conversation')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  type        text NOT NULL CHECK (type IN ('text','number','boolean','date','single_select','multi_select')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_fields_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT custom_fields_key_uq UNIQUE (tenant_id, target, key),
  CONSTRAINT custom_fields_options_ck CHECK (
    (type IN ('single_select', 'multi_select') AND jsonb_array_length(options) BETWEEN 1 AND 100)
    OR (type NOT IN ('single_select', 'multi_select') AND options = '[]'::jsonb)
  )
);

-- The catalogue is an operational contract. A definition keeps its target,
-- key and type for life; changing any of them would reinterpret historical
-- values. Options remain editable only when every element is a distinct,
-- bounded string.
CREATE FUNCTION enforce_custom_field_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.target <> OLD.target OR NEW.key <> OLD.key OR NEW.type <> OLD.type) THEN
    RAISE EXCEPTION 'custom field identity and type are immutable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.options) AS item(value)
     WHERE jsonb_typeof(value) <> 'string'
        OR length(trim(value #>> '{}')) NOT BETWEEN 1 AND 80
  ) OR (
    SELECT count(*) <> count(DISTINCT value #>> '{}')
      FROM jsonb_array_elements(NEW.options) AS item(value)
  ) THEN
    RAISE EXCEPTION 'custom field options must be distinct bounded strings';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_field_definition_shape BEFORE INSERT OR UPDATE ON custom_fields
  FOR EACH ROW EXECUTE FUNCTION enforce_custom_field_definition();

CREATE TABLE contact_custom_field_values (
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  field_id    uuid NOT NULL,
  value_json  jsonb NOT NULL,
  search_value text NOT NULL,
  updated_by_membership_id uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, field_id),
  CONSTRAINT contact_field_values_search_ck CHECK (length(search_value) <= 2000),
  CONSTRAINT contact_field_values_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_field_values_field_fk FOREIGN KEY (tenant_id, field_id)
    REFERENCES custom_fields (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_field_values_actor_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (updated_by_membership_id)
);

CREATE INDEX contact_field_values_filter_idx
  ON contact_custom_field_values (tenant_id, field_id, search_value, contact_id);

CREATE TABLE conversation_custom_field_values (
  tenant_id   uuid NOT NULL,
  conversation_id uuid NOT NULL,
  field_id    uuid NOT NULL,
  value_json  jsonb NOT NULL,
  search_value text NOT NULL,
  updated_by_membership_id uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, field_id),
  CONSTRAINT conversation_field_values_search_ck CHECK (length(search_value) <= 2000),
  CONSTRAINT conversation_field_values_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_field_values_field_fk FOREIGN KEY (tenant_id, field_id)
    REFERENCES custom_fields (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_field_values_actor_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (updated_by_membership_id)
);

CREATE INDEX conversation_field_values_filter_idx
  ON conversation_custom_field_values (tenant_id, field_id, search_value, conversation_id);

-- One append-only evidence stream for catalog and entity metadata. Entity ids
-- are polymorphic, so the service verifies their target before this insert.
CREATE TABLE metadata_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_membership_id uuid,
  act         text NOT NULL CHECK (act IN (
                'label_created','label_updated','label_retired','label_assigned','label_removed',
                'field_created','field_updated','field_retired','field_value_set','field_value_cleared'
              )),
  entity_type text NOT NULL CHECK (entity_type IN ('catalog','contact','conversation')),
  entity_id   uuid NOT NULL,
  subject_id  uuid NOT NULL,
  entity_version integer CHECK (entity_version IS NULL OR entity_version > 0),
  before_value jsonb,
  after_value  jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metadata_audit_actor_fk FOREIGN KEY (tenant_id, actor_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL (actor_membership_id)
);

CREATE INDEX metadata_audit_entity_idx
  ON metadata_audit (tenant_id, entity_type, entity_id, at DESC);

-- A retired definition remains readable and filterable for history, but it
-- cannot receive a new value. PostgreSQL repeats the API's type check so a
-- future writer cannot bypass it.
CREATE FUNCTION enforce_custom_field_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  field_target text;
  field_type text;
  field_options jsonb;
  field_state text;
BEGIN
  SELECT target, type, options, state
    INTO field_target, field_type, field_options, field_state
    FROM custom_fields WHERE id = NEW.field_id;
  IF field_target IS NULL OR field_target <> TG_ARGV[0] OR field_state <> 'active' THEN
    RAISE EXCEPTION 'custom field is unavailable for this target';
  END IF;
  IF (field_type = 'text' AND (jsonb_typeof(NEW.value_json) <> 'string'
                              OR length(trim(NEW.value_json #>> '{}')) NOT BETWEEN 1 AND 500))
     OR (field_type = 'number' AND jsonb_typeof(NEW.value_json) <> 'number')
     OR (field_type = 'boolean' AND jsonb_typeof(NEW.value_json) <> 'boolean')
     OR (field_type = 'date' AND (jsonb_typeof(NEW.value_json) <> 'string'
          OR NEW.value_json #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$'
          OR to_char(to_date(NEW.value_json #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') <> NEW.value_json #>> '{}'))
     OR (field_type = 'single_select' AND (jsonb_typeof(NEW.value_json) <> 'string' OR NOT field_options @> jsonb_build_array(NEW.value_json #>> '{}')))
     OR (field_type = 'multi_select' AND (
          jsonb_typeof(NEW.value_json) <> 'array'
          OR jsonb_array_length(NEW.value_json) NOT BETWEEN 1 AND 20
          OR NOT field_options @> NEW.value_json
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.value_json) AS item(value)
                      WHERE jsonb_typeof(value) <> 'string')
          OR (SELECT count(*) <> count(DISTINCT value #>> '{}')
                FROM jsonb_array_elements(NEW.value_json) AS item(value)))) THEN
    RAISE EXCEPTION 'custom field value has the wrong type';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_field_value_shape BEFORE INSERT OR UPDATE ON contact_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION enforce_custom_field_value('contact');
CREATE TRIGGER conversation_field_value_shape BEFORE INSERT OR UPDATE ON conversation_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION enforce_custom_field_value('conversation');

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_labels FORCE ROW LEVEL SECURITY;
ALTER TABLE contact_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_labels FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields FORCE ROW LEVEL SECURITY;
ALTER TABLE contact_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_custom_field_values FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_custom_field_values FORCE ROW LEVEL SECURITY;
ALTER TABLE metadata_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON labels USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON conversation_labels USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON contact_labels USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON custom_fields USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON contact_custom_field_values USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON conversation_custom_field_values USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON metadata_audit USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON labels, conversation_labels, contact_labels, custom_fields TO convo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_custom_field_values,
  conversation_custom_field_values TO convo_app;
GRANT SELECT, INSERT ON metadata_audit TO convo_app;

INSERT INTO permissions (key, description, delegable) VALUES
  ('catalog.read', 'Read label and typed business-field definitions', true),
  ('catalog.manage', 'Create, update and retire labels and typed business fields', false);

INSERT INTO builtin_role_grants (role_key, permission_key, scope_level) VALUES
  ('owner', 'catalog.read', 'tenant'),
  ('admin', 'catalog.read', 'tenant'),
  ('supervisor', 'catalog.read', 'scoped'),
  ('agent', 'catalog.read', 'scoped'),
  ('campaign_manager', 'catalog.read', 'scoped'),
  ('owner', 'catalog.manage', 'tenant'),
  ('admin', 'catalog.manage', 'tenant');

INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
SELECT r.tenant_id, r.id, g.permission_key, g.scope_level
  FROM roles r JOIN builtin_role_grants g ON g.role_key = r.key
 WHERE r.is_builtin AND g.permission_key IN ('catalog.read', 'catalog.manage')
ON CONFLICT DO NOTHING;

ALTER TABLE conversation_audit DROP CONSTRAINT conversation_audit_act_check;
ALTER TABLE conversation_audit ADD CONSTRAINT conversation_audit_act_check CHECK (act IN (
  'claim','assign','unassign','handoff','handoff_requested','handoff_accepted','handoff_declined',
  'handoff_cancelled','handoff_expired','priority_changed','collaborator_added','collaborator_removed',
  'owner_changed','label_added','label_removed','custom_field_changed'
));
