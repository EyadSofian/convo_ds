-- 0031_invitation_tenant_scope
-- Makes a tenant-wide invitation possible.
--
-- `invitation_scopes` was declared in 0008 with
--
--   scope_id uuid,                                    -- nullable
--   PRIMARY KEY (tenant_id, invitation_id, scope_type, scope_id)
--   CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR ...)
--
-- and those three lines cannot all hold at once. A PRIMARY KEY makes every one
-- of its columns NOT NULL, whatever the column declaration said, so the CHECK
-- demanded a NULL that the key forbade. The result was that **every tenant-wide
-- invitation failed with a not-null violation** and surfaced as HTTP 500 — the
-- ordinary case of an administrator inviting a colleague to the whole company,
-- broken since 0008 and invisible because no test covered that scope.
--
-- `membership_scopes`, written in the same migration set, gets this right: a
-- surrogate primary key, `scope_id` genuinely nullable. The invitation table
-- reached for a natural key instead and a nullable column cannot be in one.
--
-- The fix keeps the uniqueness the natural key was for — a scope may be granted
-- to an invitation once — and expresses it where NULL is allowed to mean a
-- value. `NULLS NOT DISTINCT` is what makes that uniqueness real for the tenant
-- row, exactly as 0029 needed for `automation_recipients`: without it,
-- PostgreSQL treats every NULL as distinct and the same tenant scope could be
-- attached twice.

ALTER TABLE invitation_scopes DROP CONSTRAINT invitation_scopes_pkey;

-- Dropping the key does **not** relax the columns it marked. PostgreSQL sets
-- NOT NULL on primary-key columns as an attribute of the column itself, and it
-- outlives the constraint, so without this line the table still refuses the
-- NULL the CHECK requires and nothing above changes.
ALTER TABLE invitation_scopes ALTER COLUMN scope_id DROP NOT NULL;

CREATE UNIQUE INDEX invitation_scopes_uq
  ON invitation_scopes (tenant_id, invitation_id, scope_type, scope_id) NULLS NOT DISTINCT;
