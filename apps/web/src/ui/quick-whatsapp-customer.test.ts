// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createState } from '../state.js';
import { ready, failed, IDLE, LOADING } from '../live/store.js';
import { inboxNumberCustomer, quickWhatsAppCustomer } from './quick-whatsapp-customer.js';

const error = { code: 'unavailable', status: 503, message: 'Try again', requestId: null, details: [] };
const customer = { state: 'other' as 'mine' | 'other' | 'unassigned', conversationId: null as string | null, connectionId: 'line', connectionName: 'Sales', customerName: 'Mona' as string | null, assigneeName: 'Ahmed' as string | null };
function state() { const state = createState(new Date()); state.lang = 'en'; state.dialogForm = { quickPeerIdentity: '01012345678' }; return state; }

describe('customer number check UI', () => {
  it('renders pending, failed, empty and idle results', () => {
    const app = state();
    expect(quickWhatsAppCustomer(app)).toBeNull();
    app.live.quickWhatsAppLookup = { key: 'number', result: LOADING };
    expect(quickWhatsAppCustomer(app)?.textContent).toContain('Checking number');
    app.live.quickWhatsAppLookup = { ...app.live.quickWhatsAppLookup!, result: failed(error) };
    expect(quickWhatsAppCustomer(app)?.querySelector('[data-act="live-quick-whatsapp-check"]')).not.toBeNull();
    app.live.quickWhatsAppLookup = { ...app.live.quickWhatsAppLookup!, result: IDLE };
    expect(quickWhatsAppCustomer(app)).toBeNull();
    app.live.quickWhatsAppLookup = { ...app.live.quickWhatsAppLookup!, result: ready({ customer: null }, 1) };
    expect(quickWhatsAppCustomer(app)?.textContent).toContain('No conversation');
  });
  it('shows an owner but no open control for a colleague, and opens only readable own work', () => {
    const app = state();
    app.live.quickWhatsAppLookup = { key: 'number', result: ready({ customer }, 1) };
    expect(quickWhatsAppCustomer(app)?.textContent).toContain('Follow-up owner: Ahmed');
    expect(quickWhatsAppCustomer(app)?.querySelector('button')).toBeNull();
    app.lang = 'ar';
    app.dialogForm.quickCountry = 'EG';
    app.live.quickWhatsAppLookup = { key: 'number', result: ready({ customer: { ...customer, customerName: null, assigneeName: null } }, 1) };
    expect(quickWhatsAppCustomer(app)?.textContent).toContain('موظف آخر');
    app.live.quickWhatsAppLookup = { key: 'number', result: ready({ customer: { ...customer, state: 'mine', conversationId: 'own' } }, 1) };
    expect(quickWhatsAppCustomer(app)?.querySelector('[data-act="live-quick-whatsapp-existing"]')).not.toBeNull();
    app.live.quickWhatsAppLookup = { key: 'number', result: ready({ customer: { ...customer, state: 'mine' } }, 1) };
    expect(quickWhatsAppCustomer(app)?.querySelector('button')).toBeNull();
  });
  it('offers the existing inbox for an unassigned customer on another line', () => {
    const app = state();
    app.live.quickWhatsAppLookup = { key: 'number', result: ready({ customer: { ...customer, state: 'unassigned' } }, 1) };
    expect(quickWhatsAppCustomer(app)?.querySelector('[data-act="live-quick-whatsapp-change"]')).not.toBeNull();
    app.live.quickWhatsAppOptions = ready({ connections: [{ id: 'line', displayName: 'Sales' }], templates: [] }, 1);
    expect(quickWhatsAppCustomer(app)?.querySelector('button')).toBeNull();
    app.dialogForm.quickConnectionId = 'line';
    expect(quickWhatsAppCustomer(app)?.textContent).toContain('available to claim');
  });
  it('shows exact search matches without exposing a colleague’s thread', () => {
    const app = state();
    expect(inboxNumberCustomer(app)).toBeNull();
    app.live.inboxNumberLookup = { key: '01012345678', result: LOADING };
    expect(inboxNumberCustomer(app)).toBeNull();
    app.live.inboxSearchDraft = '01012345678';
    expect(inboxNumberCustomer(app)).toBeNull();
    app.live.inboxNumberLookup = { ...app.live.inboxNumberLookup!, result: ready({ customer: null }, 1) };
    expect(inboxNumberCustomer(app)).toBeNull();
    app.live.inboxNumberLookup = { ...app.live.inboxNumberLookup!, result: ready({ customer }, 1) };
    expect(inboxNumberCustomer(app)?.textContent).toContain('Ahmed');
    expect(inboxNumberCustomer(app)?.querySelector('button')).toBeNull();
    for (const status of ['mine', 'unassigned'] as const) {
      app.live.inboxNumberLookup = { ...app.live.inboxNumberLookup!, result: ready({ customer: { ...customer, state: status, customerName: null, assigneeName: null, conversationId: 'own' } }, 1) };
      expect(inboxNumberCustomer(app)?.textContent).toContain('01012345678');
      expect(inboxNumberCustomer(app)?.querySelector('button') !== null).toBe(status === 'mine');
    }
    app.live.inboxNumberLookup = { ...app.live.inboxNumberLookup!, result: ready({ customer: { ...customer, state: 'mine' } }, 1) };
    expect(inboxNumberCustomer(app)?.querySelector('button')).toBeNull();
  });
});
