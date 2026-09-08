-- 0006_auth_sessions
-- Durable local-auth state. Raw bearer, CSRF and recovery tokens never enter
-- PostgreSQL; only server-keyed 64-character HMAC fingerprints are stored.

CREATE TABLE user_sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verifier_hash   text NOT NULL UNIQUE,
  csrf_hash       text NOT NULL,
  ip_hash         text,
  user_agent_hash text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CONSTRAINT user_sessions_verifier_hash_ck CHECK (verifier_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_csrf_hash_ck CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_ip_hash_ck CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_user_agent_hash_ck
    CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_sessions_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revocation_ck CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX user_sessions_user_active_idx
  ON user_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE auth_rate_limits (
  bucket_hash       text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count     integer NOT NULL CHECK (attempt_count >= 1),
  expires_at        timestamptz NOT NULL,
  CONSTRAINT auth_rate_limits_bucket_hash_ck CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_limits_expiry_ck CHECK (expires_at > window_started_at)
);

CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at);

CREATE TABLE password_recovery_challenges (
  id          uuid PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  target_hash text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT recovery_target_hash_ck CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recovery_token_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recovery_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT recovery_used_ck CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX password_recovery_expiry_idx
  ON password_recovery_challenges (expires_at)
  WHERE used_at IS NULL;

-- This global lookup index answers only which tenant contexts a global identity
-- may enter. Tenant names, roles and business data remain under FORCE RLS.
CREATE TABLE user_membership_index (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  membership_id uuid NOT NULL,
  PRIMARY KEY (user_id, tenant_id),
  UNIQUE (membership_id),
  CONSTRAINT user_membership_index_membership_fk
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);

-- Preserve an upgrade path for databases already used during development.
-- FORCE is restored in the same migration transaction.
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
INSERT INTO user_membership_index (user_id, tenant_id, membership_id)
SELECT user_id, tenant_id, id FROM memberships;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE FUNCTION sync_user_membership_index() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM public.user_membership_index WHERE membership_id = OLD.id;
      RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      DELETE FROM public.user_membership_index WHERE membership_id = OLD.id;
    END IF;

    INSERT INTO public.user_membership_index (user_id, tenant_id, membership_id)
    VALUES (NEW.user_id, NEW.tenant_id, NEW.id);
    RETURN NEW;
  END;
  $$;

REVOKE ALL ON FUNCTION sync_user_membership_index() FROM PUBLIC;

CREATE TRIGGER memberships_sync_global_index
  AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION sync_user_membership_index();

REVOKE ALL ON user_sessions, auth_rate_limits, password_recovery_challenges,
  user_membership_index FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sessions, auth_rate_limits,
  password_recovery_challenges TO convo_app;
GRANT SELECT ON user_membership_index TO convo_app;
