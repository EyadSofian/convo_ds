-- 0008_invitations
-- Tenant-scoped invitations with hash-only, single-use tokens.
--
-- The raw token never reaches PostgreSQL. Only an HMAC-SHA-256 fingerprint
-- under a server secret is stored, exactly as 0006 does for sessions and
-- recovery challenges: a database reader learns who was invited, not how to
-- accept as them.
--
-- `status` is derived state made explicit, because "pending" is not the absence
-- of the other three. A revoked invitation and an expired one are different
-- facts with different operator actions, and collapsing them into
-- `accepted_at IS NULL` loses that.

CREATE TABLE invitations (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- The membership that issued it, not the user: an invitation is an act
  -- inside one company, and the issuer's access can be revoked independently
  -- of their global identity.
  invited_by          uuid NOT NULL,
  email               citext NOT NULL,
  role_id             uuid NOT NULL,
  token_hash          text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_membership uuid,
  revoked_at          timestamptz,
  revoked_by          uuid,

  PRIMARY KEY (id),
  CONSTRAINT invitations_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT invitations_token_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT invitations_role_fk
    FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  CONSTRAINT invitations_inviter_fk
    FOREIGN KEY (tenant_id, invited_by) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT invitations_accepted_fk
    FOREIGN KEY (tenant_id, accepted_membership) REFERENCES memberships (tenant_id, id) ON DELETE SET NULL,

  -- Each status carries exactly the columns it means. Without these it is
  -- possible to store "accepted with no membership" or "revoked and accepted",
  -- and every later query has to guess which field to trust.
  CONSTRAINT invitations_accepted_ck CHECK (
    (status = 'accepted') = (accepted_at IS NOT NULL)
  ),
  CONSTRAINT invitations_accepted_membership_ck CHECK (
    status <> 'accepted' OR accepted_membership IS NOT NULL
  ),
  CONSTRAINT invitations_revoked_ck CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

-- At most one live invitation per address per company. A second invite to the
-- same person replaces the first rather than leaving two valid tokens: two
-- live tokens for one seat is two ways in, and revoking one would not close
-- the other.
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON invitations (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX invitations_tenant_created_idx ON invitations (tenant_id, created_at DESC);

-- The scopes the invitation asks for. They are validated against the inviter's
-- own reach when the invitation is created, and applied verbatim on accept, so
-- the grant cannot be widened between the two moments.
CREATE TABLE invitation_scopes (
  tenant_id     uuid NOT NULL,
  invitation_id uuid NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('tenant', 'team', 'inbox')),
  scope_id      uuid,
  PRIMARY KEY (tenant_id, invitation_id, scope_type, scope_id),
  CONSTRAINT invitation_scopes_invitation_fk
    FOREIGN KEY (tenant_id, invitation_id) REFERENCES invitations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT invitation_scopes_tenant_scope_ck
    CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type <> 'tenant' AND scope_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Ownership transfer.
--
-- Transfer is an offer that the recipient accepts, not something an Owner can
-- do to somebody. It expires, it can be declined or cancelled, and the
-- deferred last-Owner trigger from 0007 still guards the commit.
-- ---------------------------------------------------------------------------
CREATE TABLE ownership_transfers (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_membership uuid NOT NULL,
  to_membership   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  settled_at    timestamptz,

  PRIMARY KEY (id),
  CONSTRAINT ownership_transfers_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ownership_transfers_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT ownership_transfers_settled_ck CHECK (
    (status = 'pending') = (settled_at IS NULL)
  ),
  -- An Owner cannot transfer to themselves; that would look like a settled
  -- transfer while changing nothing.
  CONSTRAINT ownership_transfers_distinct_ck CHECK (from_membership <> to_membership),
  CONSTRAINT ownership_transfers_from_fk
    FOREIGN KEY (tenant_id, from_membership) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ownership_transfers_to_fk
    FOREIGN KEY (tenant_id, to_membership) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

-- One live offer per company. Two pending transfers would race to decide who
-- ends up Owner.
CREATE UNIQUE INDEX ownership_transfers_one_pending
  ON ownership_transfers (tenant_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS. Everything above is tenant-owned, so it is isolated the same way as the
-- rest of the schema: USING and WITH CHECK against the verified transaction
-- context, FORCE so the owner role cannot bypass it either.
-- ---------------------------------------------------------------------------
ALTER TABLE invitations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations          FORCE ROW LEVEL SECURITY;
ALTER TABLE invitation_scopes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_scopes    FORCE ROW LEVEL SECURITY;
ALTER TABLE ownership_transfers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ownership_transfers  FORCE ROW LEVEL SECURITY;

-- Reading an invitation by its own token is the one operation that happens
-- before the caller has a membership, and therefore before any tenant context
-- can be derived from one.
--
-- The carve-out is one row wide: `convo.credential_hash` is transaction-local
-- and is compared against the token fingerprint column, so a transaction that
-- sets it can see exactly the invitation whose token it already holds. It is
-- not a flag that opens the table. Writes are unaffected — WITH CHECK stays
-- tenant-only, so the accept flow must have entered the tenant's context
-- before it changes anything.
CREATE POLICY tenant_isolation ON invitations
  USING (
    tenant_id = app_current_tenant()
    OR token_hash = nullif(current_setting('convo.credential_hash', true), '')
  )
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON invitation_scopes
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenant_isolation ON ownership_transfers
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  invitations, invitation_scopes, ownership_transfers
  TO convo_app;
