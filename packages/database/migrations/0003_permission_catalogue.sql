-- 0003_permission_catalogue
-- The 29 permission keys of MASTER-PROMPT section 17. Authorization is checked
-- by key. `delegable = false` marks a key that can never be granted to a
-- service principal or a custom role by delegation (IAM-14, IAM-19).

INSERT INTO permissions (key, description, delegable) VALUES
  ('conversation.read',                'Read a full conversation timeline',            true),
  ('conversation.unassigned.preview',  'See projected queue cards for unassigned work', true),
  ('conversation.reply',               'Send a customer-visible reply',                true),
  ('conversation.note',                'Write an internal private note',               true),
  ('conversation.claim',               'Claim an unassigned conversation',             true),
  ('conversation.assign',              'Assign or reassign other people',              true),
  ('conversation.close',               'Close, reopen or snooze a conversation',       true),
  ('contact.read',                     'Read contact records',                         true),
  ('contact.edit',                     'Edit contact business fields',                 true),
  ('contact.merge',                    'Review and commit contact merges',             true),
  ('contact.export',                   'Create authorized contact exports',            true),
  ('consent.read',                     'Read consent and suppression evidence',        true),
  ('consent.record',                   'Record a consent grant',                       true),
  ('suppression.write',                'Record a suppression or opt-out',              true),
  ('campaign.read',                    'Read campaigns and recipient ledgers',         true),
  ('campaign.draft',                   'Create and validate campaign drafts',          true),
  ('campaign.approve',                 'Approve a campaign revision',                  false),
  ('campaign.launch',                  'Launch an approved campaign',                  false),
  ('campaign.control',                 'Pause, resume, cancel or retry a campaign',    false),
  ('channel.manage',                   'Administer channel connections and secrets',   false),
  ('credential.rotate',                'Rotate credentials and API keys',              false),
  ('member.manage',                    'Invite, change and remove memberships',        false),
  ('role.manage',                      'Create and edit roles',                        false),
  ('integration.manage',               'Configure integrations and webhooks',          true),
  ('api_key.manage',                   'Create and revoke API keys',                   false),
  ('report.read',                      'Read reports and analytics',                   true),
  ('audit.read',                       'Read audit events',                            false),
  ('retention.manage',                 'Change retention and privacy settings',        false),
  ('tenant.delete',                    'Request deletion of the company',              false);
