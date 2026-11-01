/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { createState } from '../state.js';
import { ready } from '../live/store.js';
import { accessMode, inboxAccessFields, readInboxAccess, selectedInboxIds } from './inbox-access.js';

function state() {
  const s = createState(new Date());
  s.lang = 'en';
  s.live.session = { status: 'signed_in', email: 'owner@test.example', memberships: [], tenantId: 't' };
  s.live.memberInboxes = ready([{ id: 'line-a', display_name: 'Admissions', kind: 'whatsapp', external_asset_id: '3904' }], 1);
  s.live.roles = ready([{ id: 'agent', key: 'agent', name: 'Agent', is_builtin: true, description: '', updated_at: '', grants: [] },
    { id: 'admin', key: 'admin', name: 'Admin', is_builtin: true, description: '', updated_at: '', grants: [] },
    { id: 'custom', key: 'custom', name: 'Custom', is_builtin: false, description: '', updated_at: '', grants: [{ permission_key: 'conversation.read', scope_level: 'tenant' }] }], 1);
  return s;
}

describe('member inbox access choices', () => {
  it('preserves legacy team scopes until the operator explicitly replaces them', () => {
    const s = state();
    const original = [{ type: 'team', id: 'sales' }, { type: 'inbox', id: 'line-a' }];
    expect(accessMode(s, 'member', original)).toBe('existing');
    expect(readInboxAccess(s, 'member', original, 'agent')).toEqual(original);
    s.dialogForm = { memberMode: 'selected', memberInbox_new: 'true', 'memberInbox_line-a': 'false' };
    expect(selectedInboxIds(s, 'member', original)).toEqual(['new']);
    expect(readInboxAccess(s, 'member', original, 'agent')).toEqual([{ type: 'inbox', id: 'new' }]);
    s.dialogForm['memberMode'] = 'none';
    expect(readInboxAccess(s, 'member', original, 'agent')).toEqual([]);
  });

  it('refuses empty or failed selections and workspace-wide roles rather than promising a false restriction', () => {
    const s = state();
    s.dialogForm = { inviteMode: 'selected' };
    expect(readInboxAccess(s, 'invite', [], 'agent')).toBeNull();
    s.dialogForm['inviteInbox_line-a'] = 'true';
    for (const role of ['admin', 'custom']) expect(readInboxAccess(s, 'invite', [], role)).toBeNull();
    s.live.memberInboxes = { status: 'error', error: { status: 503, code: 'unavailable', message: 'Cannot load inboxes', requestId: null, details: [] } };
    expect(readInboxAccess(s, 'invite', [], 'agent')).toBeNull();
    expect(inboxAccessFields(s, 'invite').textContent).toContain('The server couldn’t complete this');
    s.dialogForm['inviteMode'] = 'tenant';
    expect(readInboxAccess(s, 'invite', [], 'admin')).toEqual([{ type: 'tenant', id: null }]);
  });

  it('shows unavailable existing grants explicitly and offers their removal', () => {
    const s = state();
    const view = inboxAccessFields(s, 'member', [{ type: 'inbox', id: 'old-line' }]);
    expect(view.textContent).toContain('Admissions');
    expect(view.textContent).toContain('whatsapp · 3904');
    expect(view.textContent).toContain('Remove old-line');
    expect(view.querySelector('[data-arg="memberInbox_old-line:false"]')).not.toBeNull();
    expect(view.querySelector('[data-arg="memberInbox_line-a:true"]')?.getAttribute('aria-pressed')).toBe('false');
  });
});
