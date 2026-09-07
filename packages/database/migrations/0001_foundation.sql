-- 0001_foundation
-- Installation, tenancy and identity foundation.
--
-- Run as the MIGRATION role (owner). The runtime role must already exist; it is
-- created during cluster bootstrap, never by a migration, because role creation
-- needs privileges the runtime path must not have. See ADR-0003.

-- citext is a trusted extension from PostgreSQL 13, so the database owner can
-- install it without superuser. Emails and slugs are case-insensitive.
CREATE EXTENSION IF NOT EXISTS citext;

-- The runtime role gets no CREATE on the schema. It reads and writes rows only.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO convo_app;

-- ---------------------------------------------------------------------------
-- Tenant context. NULL when unset, so every RLS predicate defaults to DENY.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('convo.tenant_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_current_tenant() TO convo_app;

-- ---------------------------------------------------------------------------
-- Installation: exactly one row. `deployment_mode` mirrors trusted config; the
-- authority is the validated environment at boot (ADR-0002). `recovery_hold`
-- is mirrored here for visibility only -- it is enforced outside the restored
-- application snapshot (ADR-0014).
-- ---------------------------------------------------------------------------
CREATE TABLE installations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton         boolean NOT NULL DEFAULT true,
  deployment_mode   text NOT NULL CHECK (deployment_mode IN ('saas', 'self_hosted_single')),
  bootstrap_state   text NOT NULL DEFAULT 'pending'
                      CHECK (bootstrap_state IN ('pending', 'completed', 'disabled')),
  recovery_hold     boolean NOT NULL DEFAULT false,
  dispatch_epoch    integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT installations_singleton_uq UNIQUE (singleton)
);

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  slug                  citext NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'provisioning'
                          CHECK (status IN ('provisioning','active','suspended','deletion_pending','deleted')),
  placement             text NOT NULL DEFAULT 'default',
  created_at            timestamptz NOT NULL DEFAULT now(),
  suspended_at          timestamptz,
  deletion_requested_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Global human identity. NOT tenant-owned: one person may hold memberships in
-- several tenants under SaaS. Listing users is an authorized, tenant-scoped
-- operation at the service layer -- this table is never exposed directly.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text,
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','deleted')),
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permission catalogue. Global, read-only reference data. Checks are always by
-- KEY, never by role name (IAM-08).
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text NOT NULL,
  delegable   boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Roles are tenant-scoped rows, including the built-in ones, which are seeded
-- per tenant at provisioning. A shared global role table would need a nullable
-- tenant_id, which would weaken every composite foreign key that references it.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  is_builtin  boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT roles_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT roles_tenant_key_uq UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  tenant_id      uuid NOT NULL,
  role_id        uuid NOT NULL,
  permission_key text NOT NULL REFERENCES permissions (key),
  PRIMARY KEY (tenant_id, role_id, permission_key),
  CONSTRAINT role_permissions_role_fk
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Membership: this identity's access to exactly one company.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (id),
  CONSTRAINT memberships_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT memberships_tenant_user_uq UNIQUE (tenant_id, user_id),
  CONSTRAINT memberships_role_fk
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE teams (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT teams_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT teams_tenant_name_uq UNIQUE (tenant_id, name)
);

CREATE TABLE team_members (
  tenant_id     uuid NOT NULL,
  team_id       uuid NOT NULL,
  membership_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, team_id, membership_id),
  CONSTRAINT team_members_team_fk
    FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT team_members_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

-- Scope grants: which objects a membership's role may touch.
CREATE TABLE membership_scopes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  membership_id uuid NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('tenant','team','inbox')),
  scope_id      uuid,
  CONSTRAINT membership_scopes_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT membership_scopes_tenant_scope_ck
    CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type <> 'tenant' AND scope_id IS NOT NULL))
);

CREATE INDEX memberships_tenant_status_idx ON memberships (tenant_id, status);
CREATE INDEX membership_scopes_lookup_idx ON membership_scopes (tenant_id, membership_id);
