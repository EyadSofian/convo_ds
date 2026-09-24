/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { ready } from '../live/store.js';
import { createState } from '../state.js';
import { renderInbox } from './live-inbox.js';

const NOW = new Date('2026-09-20T10:00:00.000Z');

function state() {
  const app = createState(NOW);
  app.lang = 'en';
  app.route = { screen: 'inbox', conversationId: null, params: {} };
  app.live.session = { status: 'signed_in', email: 'owner@example.test', memberships: [], tenantId: 'tenant-1' };
  app.live.labels = ready([], NOW.getTime());
  app.live.savedViews = ready([], NOW.getTime());
  app.live.people = ready([], NOW.getTime());
  app.live.teams = ready([], NOW.getTime());
  app.live.connections = ready([], NOW.getTime());
  app.live.campaigns = ready([], NOW.getTime());
  app.live.customFields = ready([], NOW.getTime());
  return app;
}

describe('Inbox list controls', () => {
  it('renders the refresh action and a clearly named circular supervisor control', () => {
    const app = state();
    const root = renderInbox(app);
    expect(root.querySelector('.inbox-refresh-trigger[data-act="live-inbox-reload"]')).not.toBeNull();
    const supervisor = root.querySelector('.inbox-supervisor-trigger') as HTMLButtonElement;
    expect(supervisor.getAttribute('title')).toBe('Supervisor view');
    expect(supervisor.getAttribute('aria-label')).toBe('Supervisor view for an agent');
    expect(supervisor.getAttribute('aria-pressed')).toBe('false');
    expect(supervisor.getAttribute('aria-expanded')).toBe('false');
    app.supervisorPickerOpen = true;
    expect(renderInbox(app).querySelector('.inbox-supervisor-trigger')?.getAttribute('aria-expanded')).toBe('true');
    app.live.supervisorAgentId = 'member-1';
    expect(renderInbox(app).querySelector('.inbox-supervisor-trigger')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps Inbox refresh steady while marking only a requested refresh busy', () => {
    const app = state();
    app.live.unassigned = { status: 'loading' };
    app.live.conversations = { status: 'loading' };
    let refresh = renderInbox(app).querySelector('.inbox-refresh-trigger') as HTMLButtonElement;
    expect(refresh.hasAttribute('aria-busy')).toBe(false);
    expect(refresh.disabled).toBe(false);
    expect(refresh.querySelector('.btn__icon--refreshing')).toBeNull();

    app.live.refreshing = 'live-inbox-reload';
    refresh = renderInbox(app).querySelector('.inbox-refresh-trigger') as HTMLButtonElement;
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(refresh.disabled).toBe(true);
    expect(refresh.querySelector('.btn__icon--refreshing svg')).not.toBeNull();
  });

  it('renders supervisor picker states and a zero-safe workload banner', () => {
    const app = state();
    app.supervisorPickerOpen = true;
    app.live.supervisorAgents = { status: 'loading' };
    expect(renderInbox(app).textContent).toContain('Loading in-scope agents');
    app.live.supervisorAgents = { status: 'error', error: { code: 'forbidden', message: 'No', requestId: 'r', status: 403, details: [] } };
    expect(renderInbox(app).textContent).toContain('Supervisor view is not available');
    app.live.supervisorAgents = ready([], 1);
    expect(renderInbox(app).textContent).toContain('No active agents are available');

    const agent = { membershipId: 'member-1', name: 'Ahmed', email: 'ahmed@example.test', teams: ['Sales'] };
    app.live.supervisorAgents = ready([agent] as never, 1);
    const picker = renderInbox(app).querySelector('.inbox-supervisor-picker') as HTMLElement;
    expect((picker.querySelector('select') as HTMLSelectElement).value).toBe('');
    expect(picker.classList.contains('inbox-supervisor-picker--status')).toBe(false);
    expect(picker.querySelector('.inbox-supervisor-picker__teams')).toBeNull();
    expect(picker.querySelector('option[value="member-1"]')?.textContent).toBe('Ahmed');
    app.live.supervisorAgents = ready([agent, { ...agent, membershipId: 'member-2', email: 'ahmed2@example.test' }] as never, 1);
    const duplicatePicker = renderInbox(app).querySelector('.inbox-supervisor-picker') as HTMLElement;
    expect(duplicatePicker.querySelector('option[value="member-1"]')?.textContent).toContain('ahmed@example.test');
    app.live.supervisorAgents = ready([agent] as never, 1);
    app.live.supervisorAgentId = agent.membershipId;
    app.live.supervisorWorkload = { status: 'ready', loadedAt: 1, value: {
      agent, current: { assigned: 0, open: 0, pending: 0, snoozed: 0, unreplied: 0, urgent: 0, high: 0 }, byStatus: [], byChannel: [],
    } as never };
    const banner = renderInbox(app).querySelector('.inbox-supervisor-banner') as HTMLElement;
    expect(renderInbox(app).querySelector('.inbox-supervisor-picker__teams')?.textContent).toBe('Sales');
    expect(banner.textContent).toContain("Viewing Ahmed's workload");
    expect(banner.textContent).toContain('Sales');
    expect(banner.textContent).toContain('0 active conversations');
    expect(banner.querySelector('[data-act="live-supervisor-open-report"][data-arg="member-1"]')).not.toBeNull();
    app.live.supervisorAgents = { status: 'idle' };
    app.live.supervisorWorkload = { status: 'ready', loadedAt: 1, value: {
      agent: { ...agent, teams: ['Fallback team'] }, current: { assigned: 0, open: 0, pending: 0, snoozed: 0, unreplied: 0, urgent: 0, high: 0 }, byStatus: [], byChannel: [],
    } as never };
    expect(renderInbox(app).textContent).toContain('Fallback team');
    app.live.supervisorWorkload = { status: 'loading' };
    expect(renderInbox(app).textContent).toContain('Loading workload');
  });

  it('renders catalogue-backed custom and label filters with active chips and saved-view actions', () => {
    const app = state();
    app.openMenu = 'inbox-filters';
    app.dialogForm = { inboxFilterCatalogueSearch: '___' };
    expect(renderInbox(app).textContent).toContain('No matching filter');

    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-bool', inboxFilterOperator: 'eq' };
    app.live.customFields = ready([
      { id: 'field-bool', target: 'conversation', key: 'active', name: 'Active', type: 'boolean', options: [], state: 'active' },
      { id: 'field-choice', target: 'conversation', key: 'kind', name: 'Kind', type: 'single_select', options: ['A', 'B'], state: 'active' },
      { id: 'field-text', target: 'conversation', key: 'memo', name: 'Memo', type: 'text', options: [], state: 'active' },
      { id: 'field-multi', target: 'conversation', key: 'labels', name: 'Kinds', type: 'multi_select', options: ['A'], state: 'active' },
    ] as never, 1);
    expect(renderInbox(app).querySelector('select[aria-label="Filter value"]')).not.toBeNull();
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-bool', inboxFilterOperator: 'unavailable' };
    expect(renderInbox(app).querySelector('.inbox-filter-popover select[data-form="inboxFilterOperator"]')?.getAttribute('value')).toBeNull();
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-choice', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelectorAll('select[aria-label="Filter value"]')).toHaveLength(1);
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-text', inboxFilterOperator: 'contains' };
    expect(renderInbox(app).querySelector('input[aria-label="Filter value"]')).not.toBeNull();
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-multi', inboxFilterOperator: 'is_set' };
    expect(renderInbox(app).querySelector('.filter-value-editor')).toBeNull();
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'missing-field', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelector('.field__hint')?.textContent).toContain('Choose a field');
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelector('.field__hint')?.textContent).toContain('Choose a field');
    app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-unexpected', inboxFilterOperator: 'eq' };
    const priorFields = app.live.customFields.status === 'ready' ? app.live.customFields.value : [];
    app.live.customFields = ready([
      ...priorFields,
      { id: 'field-unexpected', target: 'conversation', key: 'strange', name: 'Strange', type: 'future_type', options: [], state: 'active' },
    ] as never, 1);
    expect(renderInbox(app).querySelector('input[aria-label="Filter value"]')).not.toBeNull();
    app.dialogForm = { inboxFilterKey: 'customer_phone', inboxFilterOperator: 'contains' };
    expect(renderInbox(app).querySelector('input[aria-label="Filter value"]')).not.toBeNull();
    for (const [type, expected] of [['date', 'date'], ['number', 'number'], ['email', 'email'], ['phone', 'tel']] as const) {
      const id = `field-${type}`;
      const previous = app.live.customFields.status === 'ready' ? app.live.customFields.value : [];
      app.live.customFields = ready([...previous, { id, target: 'conversation', key: type, name: type, type, options: [], state: 'active' }] as never, 1);
      app.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: id, inboxFilterOperator: 'eq' };
      expect(renderInbox(app).querySelector(`input[aria-label="Filter value"][type="${expected}"]`)).not.toBeNull();
    }

    app.dialogForm = { inboxFilterKey: 'label_id', inboxFilterOperator: 'in', inboxFilterValue: 'label-1' };
    app.live.labels = ready([
      { id: 'label-1', name: 'VIP', color: '#123456', state: 'active', version: 1 },
      { id: 'label-2', name: 'Billing', color: '#654321', state: 'active', version: 1 },
    ] as never, 1);
    const labelPicker = renderInbox(app).querySelector('.inbox-filter-picker') as HTMLElement;
    expect(labelPicker.textContent).toContain('VIP');
    expect(labelPicker.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    for (const key of ['status', 'priority', 'channel'] as const) {
      app.dialogForm = { inboxFilterKey: key, inboxFilterOperator: 'eq' };
      expect(renderInbox(app).querySelector('select[data-form="inboxFilterValue"]')).not.toBeNull();
    }
    app.dialogForm = { inboxFilterKey: 'assignment_state', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelector('select[data-form="inboxFilterValue"]')?.textContent).toContain('Unassigned');
    app.dialogForm = { inboxFilterKey: 'unread', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelector('select[data-form="inboxFilterValue"]')).not.toBeNull();
    app.dialogForm = { inboxFilterKey: 'created_at', inboxFilterOperator: 'before' };
    expect(renderInbox(app).querySelector('input[data-form="inboxFilterValue"][type="date"]')).not.toBeNull();
    app.live.people = ready([], 1);
    app.dialogForm = { inboxFilterKey: 'assigned_agent_id', inboxFilterOperator: 'eq' };
    const emptyPicker = renderInbox(app).querySelector('select[data-form="inboxFilterValue"]') as HTMLSelectElement;
    expect(emptyPicker.disabled).toBe(true);
    expect(emptyPicker.textContent).toContain('No available values');
    app.openMenu = 'inbox-saved-views';
    app.live.selectedSavedViewId = 'gone';
    app.live.inboxQuery = { ...app.live.inboxQuery, filters: [{ key: 'campaign_id', operator: 'eq', value: 'missing-id' }] };
    const root = renderInbox(app);
    expect(root.textContent).toContain('No saved views yet');
    expect(root.querySelector('[data-act="live-inbox-saved-view-retire"][data-arg="gone"]')).not.toBeNull();
    expect(root.textContent).toContain('…');
  });

  it('uses current server catalogues for agent, team, connection, label and campaign filters', () => {
    const app = state();
    app.live.people = ready([
      { membership_id: 'agent-1', email: 'agent@example.test', status: 'active' },
      { membership_id: 'agent-2', email: 'inactive@example.test', status: 'inactive' },
    ] as never, 1);
    app.live.teams = ready([{ id: 'team-1', name: 'Sales', archived: false }, { id: 'team-2', name: 'Old', archived: true }] as never, 1);
    app.live.connections = ready([
      { id: 'connection-1', display_name: 'Main line', disconnected_at: null },
      { id: 'connection-3', display_name: 'Second line', disconnected_at: null },
      { id: 'connection-2', display_name: 'Disconnected', disconnected_at: NOW.toISOString() },
    ] as never, 1);
    app.live.labels = ready([{ id: 'label-1', name: 'VIP', color: '#123456', state: 'active' }, { id: 'label-2', name: 'Old', state: 'retired' }] as never, 1);
    app.live.campaigns = ready([{ id: 'campaign-1', name: 'Intake' }] as never, 1);
    app.openMenu = 'inbox-filters';
    for (const key of ['assigned_agent_id', 'team_id', 'connection_id', 'campaign_id'] as const) {
      app.dialogForm = { inboxFilterKey: key, inboxFilterOperator: 'eq' };
      const root = renderInbox(app);
      expect(root.querySelector('select[data-form="inboxFilterValue"]')?.textContent).not.toBe('');
      if (key === 'connection_id') {
        const options = root.querySelector('select[data-form="inboxFilterValue"]')?.textContent ?? '';
        expect(options).toContain('Main line');
        expect(options).toContain('Second line');
        expect(options).not.toContain('Disconnected');
      }
    }
    app.dialogForm = { inboxFilterKey: 'label_id', inboxFilterOperator: 'eq' };
    expect(renderInbox(app).querySelector('select[data-form="inboxFilterValue"]')?.textContent).toContain('VIP');

    app.live.inboxQuery = { ...app.live.inboxQuery, filters: [
      { key: 'assigned_agent_id', operator: 'eq', value: 'agent-1' },
      { key: 'team_id', operator: 'eq', value: 'team-1' },
      { key: 'connection_id', operator: 'eq', value: 'connection-1' },
      { key: 'label_id', operator: 'in', value: ['label-1'] },
      { key: 'campaign_id', operator: 'eq', value: 'campaign-1' },
      { key: 'assigned_agent_id', operator: 'eq', value: 'unknown-agent' },
      { key: 'team_id', operator: 'eq', value: 'unknown-team' },
      { key: 'connection_id', operator: 'eq', value: 'unknown-connection' },
      { key: 'label_id', operator: 'eq', value: 'unknown-label' },
      { key: 'campaign_id', operator: 'eq', value: 'unknown-campaign' },
      { key: 'waiting_since', operator: 'is_set' },
      { key: 'unknown_filter', operator: 'future_operator', value: 'opaque' } as never,
    ] };
    app.openMenu = null;
    const chips = renderInbox(app).querySelector('.inbox-filter-chips') as HTMLElement;
    expect(chips.textContent).toContain('agent@example.test');
    expect(chips.textContent).toContain('Sales');
    expect(chips.textContent).toContain('Main line');
    expect(chips.textContent).toContain('matches all labels VIP');
    expect(chips.textContent).toContain('Intake');
    expect(chips.textContent).toContain('Waiting since is set');
    app.live.inboxSearchDraft = 'visitor';
    expect(renderInbox(app).querySelector('[data-act="live-inbox-search"][data-arg=""]')).not.toBeNull();
    app.live.savedViews = { status: 'loading' };
    app.live.selectedSavedViewId = null;
    app.openMenu = 'inbox-saved-views';
    expect(renderInbox(app).querySelector('[data-act="live-inbox-saved-view-retire"]')).toBeNull();

    app.live.savedViews = ready([{ id: 'view-1', ownerMembershipId: 'member-1', teamId: null, name: 'My queue', resource: 'conversations', visibility: 'private', conditions: { kind: 'group', operator: 'all', conditions: [] }, version: 1 }] as never, 1);
    app.live.selectedSavedViewId = 'view-1';
    const savedViews = renderInbox(app);
    expect(savedViews.querySelector('[data-act="live-inbox-saved-view-apply"][data-arg="view-1"]')).not.toBeNull();
    expect(savedViews.textContent).toContain('My queue');
    app.live.selectedSavedViewId = 'another-view';
    expect(renderInbox(app).querySelector('[data-act="live-inbox-saved-view-apply"][data-arg="view-1"]')?.className).toContain('btn--ghost');
  });

  it('keeps supervisor conversation inspection read-only in the rendered thread', () => {
    const app = state();
    app.live.supervisorAgentId = 'member-1';
    app.live.openConversationId = 'conversation-1';
    app.live.openConversation = { status: 'ready', loadedAt: 1, value: {
      id: 'conversation-1', contactId: null, connectionId: 'connection-1', peerIdentity: 'visitor-1',
      inboxLabel: 'Website chat', channel: 'web_chat', teamId: null, assigneeMembershipId: 'member-1',
      status: 'open', priority: 'normal', version: 2, labels: [], customFields: [],
    } as never };
    app.live.timeline = ready([], 1);
    app.live.supervisorAgents = ready([{ membershipId: 'member-1', name: 'Ahmed', email: 'a@example.test', teams: [] }] as never, 1);
    app.live.supervisorWorkload = { status: 'ready', loadedAt: 1, value: {
      agent: { membershipId: 'member-1', name: 'Ahmed', email: 'a@example.test', teams: [] },
      current: { assigned: 1, open: 1, pending: 0, snoozed: 0, unreplied: 0, urgent: 0, high: 0 }, byStatus: [], byChannel: [],
    } as never };
    const root = renderInbox(app);
    expect(root.querySelector('.thread__toolbar .badge')?.textContent).toContain('Read-only');
    expect(root.querySelector('.composer')).toBeNull();
    expect(root.querySelector('[data-act="live-conversation-transition"]')).toBeNull();
  });

  it('fails closed on free-form WhatsApp replies when the service window is unknown', () => {
    const app = state();
    app.live.openConversationId = 'conversation-1';
    app.live.openConversation = { status: 'ready', loadedAt: 1, value: {
      id: 'conversation-1', contactId: null, connectionId: 'connection-1', peerIdentity: '15550001111',
      inboxLabel: 'WhatsApp', channel: 'whatsapp', teamId: null, assigneeMembershipId: 'member-1',
      status: 'open', priority: 'normal', version: 2, labels: [], customFields: [],
    } as never };
    app.live.timeline = ready([], 1);
    const root = renderInbox(app);
    expect(root.querySelector('.composer__input')).toBeNull();
    expect(root.querySelector('.composer__closed-window')).not.toBeNull();
    expect(root.textContent).toContain('We cannot verify an active WhatsApp customer service window');
    expect(root.textContent).not.toContain('24-hour messaging window closed');
  });

  it('renders the template action, distinguishes closed windows, and shows durable template content in the timeline', () => {
    const app = state();
    app.live.openConversationId = 'conversation-1';
    app.live.openConversation = { status: 'ready', loadedAt: 1, value: {
      id: 'conversation-1', contactId: null, connectionId: 'connection-1', peerIdentity: 'visitor',
      inboxLabel: 'WhatsApp', channel: 'whatsapp', teamId: null, assigneeMembershipId: 'member-1',
      status: 'open', priority: 'normal', version: 2, labels: [], customFields: [],
      serviceWindow: { status: 'closed', lastCustomerInboundAt: null, serviceWindowExpiresAt: null },
    } as never };
    app.live.timeline = ready([{
      id: 'message-1', direction: 'out', text: '', at: NOW.toISOString(), deliveryState: 'delivered',
      template_name: 'welcome', template_language: 'ar', template_preview: 'مرحبًا يا Sara',
    }] as never, 1);
    app.live.connections = ready([{ id: 'connection-1', kind: 'whatsapp', capabilities: { templates: true } }] as never, 1);
    let root = renderInbox(app);
    expect(root.querySelector('.composer__input')).toBeNull();
    expect(root.querySelector('[data-act="live-whatsapp-template-open"]')).not.toBeNull();
    expect(root.textContent).toContain('24-hour messaging window closed');
    expect(root.textContent).toContain('WhatsApp template · welcome');
    expect(root.textContent).toContain('مرحبًا يا Sara');
    app.live.connections = ready([{ id: 'connection-1', kind: 'whatsapp', capabilities: { templates: false } }] as never, 1);
    root = renderInbox(app);
    expect(root.querySelector('[data-act="live-whatsapp-template-open"]')).toBeNull();
    app.live.connections = { status: 'loading' };
    expect(renderInbox(app).querySelector('[data-act="live-whatsapp-template-open"]')).toBeNull();
  });

  it('keeps free-form reply available in an open window but hides template controls in the supervisor lens', () => {
    const app = state();
    app.live.openConversationId = 'conversation-1';
    app.live.openConversation = { status: 'ready', loadedAt: 1, value: {
      id: 'conversation-1', contactId: null, connectionId: 'connection-1', peerIdentity: 'visitor',
      inboxLabel: 'WhatsApp', channel: 'whatsapp', teamId: null, assigneeMembershipId: 'member-1',
      status: 'open', priority: 'normal', version: 2, labels: [], customFields: [],
      serviceWindow: { status: 'open', lastCustomerInboundAt: NOW.toISOString(), serviceWindowExpiresAt: new Date(NOW.getTime() + 86400000).toISOString() },
    } as never };
    app.live.connections = ready([{ id: 'connection-1', kind: 'whatsapp', capabilities: { templates: true } }] as never, 1);
    let root = renderInbox(app);
    expect(root.querySelector('.composer__input')).not.toBeNull();
    expect(root.querySelector('[data-act="live-whatsapp-template-open"]')).not.toBeNull();
    app.live.supervisorAgentId = 'member-1';
    root = renderInbox(app);
    expect(root.querySelector('.composer__input')).toBeNull();
    expect(root.querySelector('[data-act="live-whatsapp-template-open"]')).toBeNull();
  });
});
