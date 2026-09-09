-- 0009_people_admin
-- What the People, Roles and Teams screens need in order to change anything.
--
-- Three additions, each because the current schema cannot express a state the
-- product has to have:
--
--   1. `teams.archived_at` — a team that stops being used is not the same as a
--      team that never existed. Deleting it would take its routing history and
--      its membership rows with it.
--   2. `roles.updated_at` / `roles.description` — a custom role is authored by
--      a person and needs to say what it is for.
--   3. `admin_audit_events` — every membership, role and team change is an
--      administrative act. Recording it is a requirement (AUD-01), and doing it
--      in the same transaction as the change is the only way the two cannot
--      disagree.

ALTER TABLE teams ADD COLUMN archived_at timestamptz;

-- A name is only reserved while the team is live, so an archived "Enrollment"
-- does not block a new one.
ALTER TABLE teams DROP CONSTRAINT teams_tenant_name_uq;
CREATE UNIQUE INDEX teams_tenant_name_live_uq
  ON teams (tenant_id, name)
  WHERE archived_at IS NULL;

ALTER TABLE roles ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE roles ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- A built-in role is defined by the product, not by the tenant. Enforcing that
-- here means a service bug cannot rewrite the matrix every authorization
-- decision is made against.
CREATE FUNCTION reject_builtin_role_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.is_builtin THEN
        RAISE EXCEPTION 'convo: a built-in role cannot be deleted'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN OLD;
    END IF;

    -- Renaming, re-keying or re-describing a built-in role is refused. The
    -- `updated_at` bump alone is allowed so a no-op touch is not an error.
    IF OLD.is_builtin AND (
         NEW.key IS DISTINCT FROM OLD.key
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.is_builtin IS DISTINCT FROM OLD.is_builtin
    ) THEN
      RAISE EXCEPTION 'convo: a built-in role cannot be edited'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
  $$;

REVOKE ALL ON FUNCTION reject_builtin_role_change() FROM PUBLIC;

CREATE TRIGGER roles_builtin_immutable
  BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION reject_builtin_role_change();

-- The grants of a built-in role ARE the matrix, so the rule is not "no writes"
-- but "must equal the reference matrix".
--
-- A blanket refusal would also block the legitimate write: every new company
-- seeds its built-in roles at creation, from `builtin_role_grants`. Allowing
-- exactly the rows that already exist in that table permits the seed and
-- refuses everything else — an added key, a widened scope, an edit, a delete —
-- which is a stronger guarantee than "nothing may write here", because it also
-- catches a seed that disagrees with the matrix.
CREATE FUNCTION reject_builtin_grant_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    target uuid := COALESCE(NEW.role_id, OLD.role_id);
    builtin boolean;
  BEGIN
    SELECT r.is_builtin INTO builtin FROM public.roles r WHERE r.id = target;

    IF NOT builtin THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1
        FROM public.roles r
        JOIN public.builtin_role_grants g ON g.role_key = r.key
       WHERE r.id = NEW.role_id
         AND g.permission_key = NEW.permission_key
         AND g.scope_level = NEW.scope_level
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'convo: the grants of a built-in role cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;

REVOKE ALL ON FUNCTION reject_builtin_grant_change() FROM PUBLIC;

CREATE TRIGGER role_permissions_builtin_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION reject_builtin_grant_change();

-- ---------------------------------------------------------------------------
-- Administrative audit.
--
-- `actor_membership` is nullable because an act can outlive the membership that
-- performed it; the recorded email is the durable evidence. `detail` is a
-- closed jsonb object written by the service, never free text from a client.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_audit_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_membership  uuid,
  actor_email       citext NOT NULL,
  action            text NOT NULL,
  subject_type      text NOT NULL CHECK (subject_type IN ('membership', 'role', 'team', 'invitation', 'ownership')),
  subject_id        uuid,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_actor_fk
    FOREIGN KEY (tenant_id, actor_membership) REFERENCES memberships (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX admin_audit_tenant_time_idx ON admin_audit_events (tenant_id, occurred_at DESC);

ALTER TABLE admin_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_events FORCE ROW LEVEL SECURITY;

-- Append-only from the application's side: there is no UPDATE or DELETE grant,
-- so an audit row cannot be edited or removed by the runtime role at all.
CREATE POLICY tenant_isolation ON admin_audit_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON admin_audit_events TO convo_app;
