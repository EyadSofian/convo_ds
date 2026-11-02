import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { lookupInboxNumber } from './inbox-number-lookup.js';
const error = { status: 503, code: 'unavailable', message: 'Try again', requestId: null, details: [] };
function setup() {
  const state = createState(new Date());
  state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'tenant' };
  const options = vi.fn().mockResolvedValue({ ok: true, data: { connections: [{ id: 'line' }], templates: [] } });
  const lookup = vi.fn().mockResolvedValue({ ok: true, data: { customer: null } });
  Object.assign(state.live, { channels: { quickWhatsAppOptions: options, lookupQuickWhatsApp: lookup } });
  const context = { state, live: state.live, now: () => 1, refresh: vi.fn() } as unknown as LiveContext;
  return { state, context, options, lookup };
}
describe('Inbox exact number discovery', () => {
  it('looks up a normalized number using only the agent’s available sending lines', async () => {
    const ctx = setup();
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.lookup).toHaveBeenCalledWith('tenant', 'line', '+201012345678');
    expect(ctx.state.live.inboxNumberLookup?.result.status).toBe('ready');
  });
  it('skips names, supervision, missing sessions and unavailable sending lines', async () => {
    const ctx = setup();
    await lookupInboxNumber(ctx.context, 'Mona');
    ctx.state.live.supervisorAgentId = 'colleague';
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.options).not.toHaveBeenCalled();
    ctx.state.live.supervisorAgentId = null;
    ctx.state.live.session = { status: 'signed_out', error: null };
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.options).not.toHaveBeenCalled();
    ctx.state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'tenant' };
    ctx.options.mockResolvedValueOnce({ ok: true, data: { connections: [] } });
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.state.live.inboxNumberLookup).toBeNull();
  });
  it('surfaces lookup errors without treating them as a new customer', async () => {
    const ctx = setup();
    ctx.options.mockResolvedValueOnce({ ok: false, error });
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.state.live.inboxNumberLookup?.result.status).toBe('error');
    ctx.lookup.mockResolvedValueOnce({ ok: false, error });
    await lookupInboxNumber(ctx.context, '01012345678');
    expect(ctx.state.live.inboxNumberLookup?.result.status).toBe('error');
  });
  it('discards old options and lookup responses after the search is replaced', async () => {
    for (const stage of ['options', 'lookup']) {
      const ctx = setup();
      let resolve!: (value: unknown) => void;
      const target = stage === 'options' ? ctx.options : ctx.lookup;
      target.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
      const searching = lookupInboxNumber(ctx.context, '01012345678');
      await Promise.resolve();
      await lookupInboxNumber(ctx.context, 'Mona');
      resolve({ ok: true, data: stage === 'options' ? { connections: [{ id: 'line' }] } : { customer: null } });
      await searching;
      expect(ctx.state.live.inboxNumberLookup).toBeNull();
    }
  });
});
