-- Account-level security evidence. Password changes are not tenant-scoped: one
-- user can belong to several workspaces, so the audit row follows the identity.
CREATE TABLE account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('password.changed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_security_events_user_time_idx
  ON account_security_events(user_id,occurred_at DESC,id DESC);

GRANT SELECT,INSERT ON account_security_events TO convo_app;
