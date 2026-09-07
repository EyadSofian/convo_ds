-- 0002_rls
-- Row level security. Defence in depth BEHIND application authorization, not
-- instead of it (ADR-0003). Both USING and WITH CHECK are declared, and FORCE
-- is set so a future owner-role write path cannot quietly bypass the policy.
--
-- Every predicate compares against app_current_tenant(), which is NULL when the
-- transaction has not set convo.tenant_id. `tenant_id = NULL` is NULL, which is
-- not true, so the default is DENY.

-- Tenant-owned tables ------------------------------------------------------
ALTER TABLE tenants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants            FORCE ROW LEVEL SECURITY;
ALTER TABLE roles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles              FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions   FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships        ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships        FORCE ROW LEVEL SECURITY;
ALTER TABLE teams              ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams              FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members       FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_scopes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_scopes  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON role_permissions
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON teams
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON team_members
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON membership_scopes
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Grants -------------------------------------------------------------------
-- The runtime role may read and write rows. It owns nothing, creates nothing,
-- and holds no BYPASSRLS. Sequences are not granted because every primary key
-- is a uuid default, not a serial.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, roles, role_permissions, memberships, teams, team_members, membership_scopes
  TO convo_app;

-- Global, non-tenant tables. `users` is a global identity table: it is never
-- exposed directly to a client, and every listing of people goes through a
-- tenant-scoped membership query.
GRANT SELECT, INSERT, UPDATE ON users TO convo_app;
GRANT SELECT ON permissions TO convo_app;
GRANT SELECT, UPDATE ON installations TO convo_app;
