import { describe, expect, it, vi } from 'vitest';
import type { Principal, SqlExecutor } from '@convo/domain';
import { findQuickWhatsAppCustomer } from './quick-whatsapp-customer.js';

const principal: Principal = { membershipId: 'me', membershipStatus: 'active', tenantStatus: 'active', grants: { 'conversation.reply': 'own', 'conversation.read': 'own' }, scopes: [{ type: 'inbox', id: 'available' }], delegationCeiling: null };
const row = { id: 'thread', connection_id: 'available', connection_name: 'Sales', team_id: null, assignee_membership_id: 'other', assignee_name: 'Ahmed', customer_name: 'Mona' };
const sql = (rows: readonly object[]) => ({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) }) as unknown as SqlExecutor;

describe('exact-number customer directory', () => {
  it('shows the follow-up owner without exposing a colleague’s conversation identifier or messages', async () => {
    const result = await findQuickWhatsAppCustomer(sql([row]), principal, '201012345678', 'available');
    expect(result).toEqual({ state: 'other', conversationId: null, connectionId: 'available', connectionName: 'Sales', customerName: 'Mona', assigneeName: 'Ahmed' });
  });
  it('returns no result from an inbox outside the agent’s scopes', async () => {
    expect(await findQuickWhatsAppCustomer(sql([{ ...row, connection_id: 'hidden' }]), principal, '201012345678', 'available')).toBeNull();
  });
  it('opens only the current agent’s readable conversation, including a team assignment', async () => {
    const own = { ...row, assignee_membership_id: 'me', team_id: 'team' };
    expect(await findQuickWhatsAppCustomer(sql([own]), principal, '201012345678', 'available')).toMatchObject({ state: 'mine', conversationId: 'thread' });
    expect(await findQuickWhatsAppCustomer(sql([own]), { ...principal, grants: { 'conversation.reply': 'own' } }, '201012345678', 'available')).toMatchObject({ state: 'mine', conversationId: null });
  });
  it('finds an existing assignment on another available line before an unassigned candidate', async () => {
    const all: Principal = { ...principal, scopes: [{ type: 'tenant', id: null }] };
    expect(await findQuickWhatsAppCustomer(sql([{ ...row, assignee_membership_id: null }, { ...row, connection_id: 'second' }]), all, '201012345678', 'third')).toMatchObject({ state: 'other', connectionId: 'second' });
    expect(await findQuickWhatsAppCustomer(sql([{ ...row, assignee_membership_id: null }, { ...row, connection_id: 'second' }]), all, '201012345678', 'available')).toMatchObject({ state: 'other', connectionId: 'second' });
    expect(await findQuickWhatsAppCustomer(sql([{ ...row, assignee_membership_id: null }]), all, '201012345678', 'available')).toMatchObject({ state: 'unassigned' });
    expect(await findQuickWhatsAppCustomer(sql([{ ...row, assignee_membership_id: null }]), all, '201012345678', 'third')).toMatchObject({ state: 'unassigned', conversationId: null });
    expect(await findQuickWhatsAppCustomer(sql([]), all, '201012345678', 'third')).toBeNull();
  });
});
