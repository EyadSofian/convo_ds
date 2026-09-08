-- 0007_role_matrix
-- The seven built-in tenant roles and their scope matrices.
--
-- Two things change here:
--
--   1. `role_permissions` gains `scope_level`. A grant without a scope is not a
--      grant: "may read conversations" is meaningless until it says whether
--      that means the whole company, an allowed inbox, or only assigned work.
--      Until now the column did not exist and every grant behaved as tenant-wide.
--
--   2. All seven built-in roles are seeded per tenant. Before this migration a
--      tenant had exactly one role -- Owner -- created by the installation
--      bootstrap, so there was nothing to invite anybody into.
--
-- The matrix below is `docs/product/business-rules.md` section 7, and it is
-- mirrored in `packages/domain/src/iam/roles.ts`. `roles.test.ts` parses this
-- file and fails if the two disagree, so neither can drift alone.
--
-- Platform Super Admin is deliberately NOT here: it sits outside tenant
-- membership entirely and reaches the installation through /platform.

ALTER TABLE role_permissions
  ADD COLUMN scope_level text NOT NULL DEFAULT 'tenant'
    CHECK (scope_level IN ('tenant', 'scoped', 'own'));

-- `none` is absent from the CHECK on purpose: a denial is the ABSENCE of a row,
-- never a row that says no. One representation of "denied" means one place to
-- get it wrong.
COMMENT ON COLUMN role_permissions.scope_level IS
  'How far the grant reaches. Denial is the absence of a row, not a row saying none.';

-- ---------------------------------------------------------------------------
-- The matrix, as reference data the seeding statements join against.
-- ---------------------------------------------------------------------------
CREATE TABLE builtin_role_definitions (
  role_key    text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (role_key)
);

CREATE TABLE builtin_role_grants (
  role_key       text NOT NULL REFERENCES builtin_role_definitions (role_key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key),
  scope_level    text NOT NULL CHECK (scope_level IN ('tenant', 'scoped', 'own')),
  PRIMARY KEY (role_key, permission_key)
);

INSERT INTO builtin_role_definitions (role_key, name) VALUES
  ('owner', 'Owner'),
  ('admin', 'Admin'),
  ('supervisor', 'Supervisor'),
  ('agent', 'Agent'),
  ('campaign_manager', 'Campaign Manager'),
  ('analyst', 'Analyst'),
  ('integration_developer', 'Integration Developer');

INSERT INTO builtin_role_grants (role_key, permission_key, scope_level) VALUES
  ('owner', 'api_key.manage', 'tenant'),
  ('owner', 'audit.read', 'tenant'),
  ('owner', 'campaign.approve', 'tenant'),
  ('owner', 'campaign.control', 'tenant'),
  ('owner', 'campaign.draft', 'tenant'),
  ('owner', 'campaign.launch', 'tenant'),
  ('owner', 'campaign.read', 'tenant'),
  ('owner', 'channel.manage', 'tenant'),
  ('owner', 'consent.read', 'tenant'),
  ('owner', 'consent.record', 'tenant'),
  ('owner', 'contact.edit', 'tenant'),
  ('owner', 'contact.export', 'tenant'),
  ('owner', 'contact.merge', 'tenant'),
  ('owner', 'contact.read', 'tenant'),
  ('owner', 'conversation.assign', 'tenant'),
  ('owner', 'conversation.claim', 'tenant'),
  ('owner', 'conversation.close', 'tenant'),
  ('owner', 'conversation.note', 'tenant'),
  ('owner', 'conversation.read', 'tenant'),
  ('owner', 'conversation.reply', 'tenant'),
  ('owner', 'conversation.unassigned.preview', 'tenant'),
  ('owner', 'credential.rotate', 'tenant'),
  ('owner', 'integration.manage', 'tenant'),
  ('owner', 'member.manage', 'tenant'),
  ('owner', 'report.read', 'tenant'),
  ('owner', 'retention.manage', 'tenant'),
  ('owner', 'role.manage', 'tenant'),
  ('owner', 'suppression.write', 'tenant'),
  ('owner', 'tenant.delete', 'tenant'),
  ('admin', 'api_key.manage', 'tenant'),
  ('admin', 'audit.read', 'tenant'),
  ('admin', 'campaign.approve', 'tenant'),
  ('admin', 'campaign.control', 'tenant'),
  ('admin', 'campaign.draft', 'tenant'),
  ('admin', 'campaign.launch', 'tenant'),
  ('admin', 'campaign.read', 'tenant'),
  ('admin', 'channel.manage', 'tenant'),
  ('admin', 'consent.read', 'tenant'),
  ('admin', 'consent.record', 'tenant'),
  ('admin', 'contact.edit', 'tenant'),
  ('admin', 'contact.export', 'tenant'),
  ('admin', 'contact.merge', 'tenant'),
  ('admin', 'contact.read', 'tenant'),
  ('admin', 'conversation.assign', 'tenant'),
  ('admin', 'conversation.claim', 'tenant'),
  ('admin', 'conversation.close', 'tenant'),
  ('admin', 'conversation.note', 'tenant'),
  ('admin', 'conversation.read', 'tenant'),
  ('admin', 'conversation.reply', 'tenant'),
  ('admin', 'conversation.unassigned.preview', 'tenant'),
  ('admin', 'credential.rotate', 'tenant'),
  ('admin', 'integration.manage', 'tenant'),
  ('admin', 'member.manage', 'tenant'),
  ('admin', 'report.read', 'tenant'),
  ('admin', 'retention.manage', 'tenant'),
  ('admin', 'role.manage', 'tenant'),
  ('admin', 'suppression.write', 'tenant'),
  ('supervisor', 'consent.read', 'scoped'),
  ('supervisor', 'consent.record', 'scoped'),
  ('supervisor', 'contact.edit', 'scoped'),
  ('supervisor', 'contact.read', 'scoped'),
  ('supervisor', 'conversation.assign', 'scoped'),
  ('supervisor', 'conversation.claim', 'scoped'),
  ('supervisor', 'conversation.close', 'scoped'),
  ('supervisor', 'conversation.note', 'scoped'),
  ('supervisor', 'conversation.read', 'scoped'),
  ('supervisor', 'conversation.reply', 'scoped'),
  ('supervisor', 'conversation.unassigned.preview', 'scoped'),
  ('supervisor', 'report.read', 'scoped'),
  ('supervisor', 'suppression.write', 'scoped'),
  ('agent', 'consent.read', 'own'),
  ('agent', 'consent.record', 'own'),
  ('agent', 'contact.edit', 'own'),
  ('agent', 'contact.read', 'own'),
  ('agent', 'conversation.claim', 'scoped'),
  ('agent', 'conversation.close', 'own'),
  ('agent', 'conversation.note', 'own'),
  ('agent', 'conversation.read', 'own'),
  ('agent', 'conversation.reply', 'own'),
  ('agent', 'conversation.unassigned.preview', 'scoped'),
  ('agent', 'report.read', 'own'),
  ('agent', 'suppression.write', 'own'),
  ('campaign_manager', 'campaign.control', 'scoped'),
  ('campaign_manager', 'campaign.draft', 'scoped'),
  ('campaign_manager', 'campaign.launch', 'scoped'),
  ('campaign_manager', 'campaign.read', 'scoped'),
  ('campaign_manager', 'consent.read', 'scoped'),
  ('campaign_manager', 'consent.record', 'scoped'),
  ('campaign_manager', 'contact.edit', 'scoped'),
  ('campaign_manager', 'contact.read', 'scoped'),
  ('campaign_manager', 'report.read', 'scoped'),
  ('campaign_manager', 'suppression.write', 'scoped'),
  ('analyst', 'report.read', 'tenant'),
  ('integration_developer', 'integration.manage', 'tenant'),
  ('integration_developer', 'report.read', 'scoped');

-- ---------------------------------------------------------------------------
-- Seed every existing tenant.
--
-- FORCE RLS applies to the table owner as well, and this migration runs as the
-- migration role with no tenant context set, so the policy would hide every
-- row. FORCE is lifted and restored inside the same transaction, exactly as
-- 0006 does for the membership index -- the window never spans a commit.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

-- Existing Owner rows predate the matrix; restate their grants with a scope.
UPDATE role_permissions SET scope_level = 'tenant'
  WHERE role_id IN (SELECT id FROM roles WHERE key = 'owner');

INSERT INTO roles (tenant_id, key, name, is_builtin)
SELECT t.id, d.role_key, d.name, true
FROM tenants t
CROSS JOIN builtin_role_definitions d
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
SELECT r.tenant_id, r.id, g.permission_key, g.scope_level
FROM roles r
JOIN builtin_role_grants g ON g.role_key = r.key
WHERE r.is_builtin IS TRUE
ON CONFLICT (tenant_id, role_id, permission_key) DO UPDATE
  SET scope_level = EXCLUDED.scope_level;

ALTER TABLE tenants          FORCE ROW LEVEL SECURITY;
ALTER TABLE roles            FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Last-active-Owner protection.
--
-- Enforced in the database, not only in a service: a company must never be left
-- with nobody who can administer it, and two concurrent transactions each
-- removing "the other" Owner would both pass an application-level check.
--
-- The trigger is a CONSTRAINT TRIGGER deferred to commit, so a transactional
-- ownership transfer -- demote A, promote B -- is legal, while ending the
-- transaction with no active Owner is not.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_tenant_has_active_owner() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    affected_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
    owner_count integer;
  BEGIN
    -- A tenant that is gone, or not live, has nothing to protect.
    IF NOT EXISTS (
      SELECT 1 FROM public.tenants
      WHERE id = affected_tenant
        AND status IN ('provisioning', 'active', 'suspended')
    ) THEN
      RETURN NULL;
    END IF;

    SELECT count(*) INTO owner_count
    FROM public.memberships m
    JOIN public.roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
    JOIN public.users u ON u.id = m.user_id
    WHERE m.tenant_id = affected_tenant
      AND m.status = 'active'
      AND u.status = 'active'
      AND r.key = 'owner';

    IF owner_count = 0 THEN
      RAISE EXCEPTION 'convo: a company must keep at least one active Owner'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NULL;
  END;
  $$;

REVOKE ALL ON FUNCTION assert_tenant_has_active_owner() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER memberships_keep_an_owner
  AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_has_active_owner();

CREATE INDEX role_permissions_key_idx ON role_permissions (tenant_id, permission_key);

GRANT SELECT ON builtin_role_definitions, builtin_role_grants TO convo_app;
