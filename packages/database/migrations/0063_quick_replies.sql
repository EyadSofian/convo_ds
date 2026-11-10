-- 0063_quick_replies
-- Saved replies an agent drops into the composer: from a button, or by typing
-- "/" and the reply's shortcut. A location reply carries a place instead of
-- free text, and the composer turns it into a message with a map link.

CREATE TABLE quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut text NOT NULL CHECK (shortcut ~ '^[^\s/]{1,32}$' AND shortcut = lower(shortcut)),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('text','location')),
  body text NOT NULL CHECK (length(body) <= 4000),
  location jsonb CHECK (location IS NULL OR jsonb_typeof(location) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_membership_id uuid,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT quick_replies_shortcut_uq UNIQUE (tenant_id,shortcut),
  CONSTRAINT quick_replies_kind_ck CHECK (
    (kind = 'text' AND location IS NULL AND length(trim(body)) > 0)
    OR (kind = 'location' AND location IS NOT NULL)
  ),
  CONSTRAINT quick_replies_creator_fk FOREIGN KEY (tenant_id,created_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (created_by_membership_id),
  CONSTRAINT quick_replies_updater_fk FOREIGN KEY (tenant_id,updated_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (updated_by_membership_id)
);

ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_replies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON quick_replies
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT,UPDATE,DELETE ON quick_replies TO convo_app;
