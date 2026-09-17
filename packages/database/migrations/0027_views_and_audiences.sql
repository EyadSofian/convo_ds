-- 0027_views_and_audiences
-- Reusable, validated filter definitions. These tables store condition ASTs;
-- the API owns validation and compilers use closed field/operator vocabularies.

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_membership_id uuid NOT NULL,
  team_id uuid,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  resource text NOT NULL CHECK (resource IN ('conversations','contacts')),
  visibility text NOT NULL CHECK (visibility IN ('private','team','workspace')),
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions)='object'),
  sort_spec jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sort_spec)='array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT saved_views_owner_fk FOREIGN KEY (tenant_id,owner_membership_id)
    REFERENCES memberships(tenant_id,id),
  CONSTRAINT saved_views_team_fk FOREIGN KEY (tenant_id,team_id)
    REFERENCES teams(tenant_id,id),
  CONSTRAINT saved_views_visibility_ck CHECK (
    (visibility='private' AND team_id IS NULL)
    OR (visibility='team' AND team_id IS NOT NULL)
    OR (visibility='workspace' AND team_id IS NULL)
  )
);

CREATE INDEX saved_views_visible_idx
  ON saved_views(tenant_id,resource,visibility,team_id,owner_membership_id)
  WHERE state='active';

CREATE TABLE audiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions)='object'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_membership_id uuid,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audiences_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT audiences_name_uq UNIQUE (tenant_id,name),
  CONSTRAINT audiences_creator_fk FOREIGN KEY (tenant_id,created_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (created_by_membership_id),
  CONSTRAINT audiences_updater_fk FOREIGN KEY (tenant_id,updated_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (updated_by_membership_id)
);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
ALTER TABLE audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE audiences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON saved_views
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON audiences
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT,UPDATE ON saved_views,audiences TO convo_app;
