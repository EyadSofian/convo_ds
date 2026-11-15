-- 0064_operations_role
-- An eighth built-in role: Operations.
--
-- Operations works its own inboxes and watches everyone else's. Every read is
-- granted at `tenant`, so the person can open any inbox, conversation, contact,
-- campaign or report in the company. Every write is granted at `scoped`, so
-- replying, claiming, assigning, closing, editing a contact and sending a
-- campaign are refused outside the inboxes on the membership's own scope.
-- Another inbox is therefore view-only, and the server is what makes it so.
--
-- Mirrored in `packages/domain/src/iam/roles.ts` and `business-rules.md` §7;
-- `roles.test.ts` parses this file and fails if the two disagree.

INSERT INTO builtin_role_definitions (role_key, name) VALUES
  ('operations', 'Operations');

INSERT INTO builtin_role_grants (role_key, permission_key, scope_level) VALUES
  ('operations', 'campaign.approve', 'scoped'),
  ('operations', 'campaign.control', 'scoped'),
  ('operations', 'campaign.draft', 'scoped'),
  ('operations', 'campaign.launch', 'scoped'),
  ('operations', 'campaign.read', 'tenant'),
  ('operations', 'catalog.read', 'tenant'),
  ('operations', 'consent.read', 'tenant'),
  ('operations', 'consent.record', 'scoped'),
  ('operations', 'contact.edit', 'scoped'),
  ('operations', 'contact.read', 'tenant'),
  ('operations', 'conversation.assign', 'scoped'),
  ('operations', 'conversation.claim', 'scoped'),
  ('operations', 'conversation.close', 'scoped'),
  ('operations', 'conversation.handoff.request', 'scoped'),
  ('operations', 'conversation.note', 'scoped'),
  ('operations', 'conversation.read', 'tenant'),
  ('operations', 'conversation.reply', 'scoped'),
  ('operations', 'conversation.unassigned.preview', 'tenant'),
  ('operations', 'report.read', 'tenant'),
  ('operations', 'suppression.write', 'scoped');

-- Tenants provisioned before this migration get the role too. New tenants are
-- seeded from the reference tables by the installation bootstrap. Custom roles
-- are always keyed `custom_…`, so `operations` cannot collide with one; the
-- conflict clause only makes a re-run harmless.
INSERT INTO roles (tenant_id, key, name, is_builtin)
SELECT t.id, d.role_key, d.name, true
  FROM tenants t
  CROSS JOIN builtin_role_definitions d
 WHERE d.role_key = 'operations'
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Read from `builtin_role_grants` rather than repeating the levels, so the two
-- can never be seeded differently. The built-in grant trigger accepts exactly
-- these rows and nothing else.
INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
SELECT r.tenant_id, r.id, g.permission_key, g.scope_level
  FROM roles r
  JOIN builtin_role_grants g ON g.role_key = r.key
 WHERE r.is_builtin AND r.key = 'operations'
ON CONFLICT DO NOTHING;
