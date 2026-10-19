/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { Contact } from '../api/contacts.js';
import { createState } from '../state.js';
import { contactBody } from './contact-panel.js';

const contact: Contact = {
  id: 'contact-1', displayName: 'Mona', attributes: {}, version: 1, labels: [], customFields: [], createdAt: '2026-10-19T00:00:00Z',
  identities: [{ id: 'identity-1', kind: 'whatsapp', scopeId: 'cn-1', externalId: '201500000000', validFrom: '2026-10-19T00:00:00Z', validTo: null }],
  consent: [], suppressed: [],
};

function render(permissions: readonly string[], value: Contact = contact, where: 'screen' | 'panel' = 'screen') {
  const state = createState(new Date('2026-10-19T12:00:00Z'));
  state.live.session = {
    status: 'signed_in', email: 'admin@example.com', tenantId: 'tenant-1',
    memberships: [{ id: 'member-1', tenant: { id: 'tenant-1', name: 'School', slug: 'school' }, role: { id: 'role-1', key: 'admin', name: 'Admin' }, permissions }],
  };
  return contactBody(state, value, state.live, where);
}

describe('send from Contacts', () => {
  const grants = ['conversation.reply', 'automation.read', 'channel.manage'];
  it('offers an approved WhatsApp template on an authorized contact profile', () => {
    expect(render(grants).querySelector('[data-act="live-contact-template-open"]')?.getAttribute('data-arg')).toBe(contact.id);
  });
  it('does not offer a direct send for the inbox panel, missing permissions, opt-outs or non-WhatsApp contacts', () => {
    expect(render(grants, contact, 'panel').querySelector('[data-act="live-contact-template-open"]')).toBeNull();
    expect(render([]).querySelector('[data-act="live-contact-template-open"]')).toBeNull();
    expect(render(['conversation.reply']).querySelector('[data-act="live-contact-template-open"]')).toBeNull();
    expect(render(['conversation.reply', 'automation.read']).querySelector('[data-act="live-contact-template-open"]')).toBeNull();
    expect(render(grants, { ...contact, suppressed: ['whatsapp'] }).querySelector('[data-act="live-contact-template-open"]')).toBeNull();
    expect(render(grants, { ...contact, identities: [] }).querySelector('[data-act="live-contact-template-open"]')).toBeNull();
  });
});
