/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { Campaign, CampaignRecipient } from '../api/campaigns';
import type { ChannelConnection } from '../api/channels';
import { createState } from '../state';
import type { AppState } from '../state';
import { campaignBucket, campaignStateBadge, errorCodeOf, renderBroadcasts } from './campaigns-screen';

/**
 * Campaigns. Each lifecycle step is offered only from a state the server accepts
 * it in, and only to a membership whose server-issued keys include it.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');
const ALL = ['campaign.read', 'campaign.draft', 'campaign.approve', 'campaign.launch', 'campaign.control', 'report.read'];

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c-1', name: 'Autumn intake', objective: 'Enrolment', connection_id: 'cn-1', state: 'draft', version: 3,
    revision_id: 'rev-1', revision: 2, revision_hash: 'a'.repeat(64), content: { text: 'Hi' }, variables: {},
    audience_filter: {}, timezone: 'Africa/Cairo', expires_at: null, budget_amount_minor: '0', budget_currency: 'USD',
    approved: false, audience: null, execution: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function screen(campaigns: readonly Campaign[], permissions: readonly string[] = ALL, lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = {
    status: 'signed_in', email: 'a@b.c', tenantId: 't',
    memberships: [{ id: 'm', tenant: { id: 't', name: 'School', slug: 'school' }, role: { id: 'r', key: 'x', name: 'X' }, permissions }],
  };
  state.live.campaigns = { status: 'ready', loadedAt: 1, value: campaigns };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Admissions', status: 'healthy', disconnected_at: null } as ChannelConnection] };
  return state;
}

function actions(state: AppState): string[] {
  return Array.from(renderBroadcasts(state).querySelectorAll('.action-bar [data-act]')).map((element) => {
    const act = element.getAttribute('data-act') ?? '';
    const arg = element.getAttribute('data-arg') ?? '';
    return act === 'dialog' ? arg.split(':')[0] as string : act === 'live-campaign-control' ? `control:${arg.split(':')[1] as string}` : act;
  });
}

describe('the state badge', () => {
  it('names a state this build does not know by the server’s word, in a neutral tone', () => {
    const state = createState(new Date('2026-09-09T09:30:00.000Z'));
    state.lang = 'en';
    expect(campaignStateBadge(state, 'failed').className).toBe('badge badge--danger');
    const unknown = campaignStateBadge(state, 'archived');
    expect(unknown.className).toBe('badge badge--neutral');
    expect(unknown.textContent).toBe('archived');
  });
});

describe('the list', () => {
  it('draws a loading state, a refusal and an empty workspace distinctly', () => {
    const state = screen([]);
    state.live.campaigns = { status: 'loading' };
    expect(renderBroadcasts(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.campaigns = { status: 'idle' };
    expect(renderBroadcasts(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.campaigns = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r-1', status: 500, details: [] } };
    expect(renderBroadcasts(state).textContent).toContain('r-1');
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [] };
    const empty = renderBroadcasts(state);
    expect(empty.textContent).toContain('No broadcasts yet');
    expect(empty.querySelector('.empty [data-act="live-campaign-editor"]')).not.toBeNull();
  });

  it('does not offer a new campaign without the draft key', () => {
    const state = screen([], ['campaign.read']);
    const root = renderBroadcasts(state);
    expect(root.querySelector('[data-act="live-campaign-editor"]')).toBeNull();
    expect(root.textContent).toContain('No broadcast has been created');
  });

  it('summarises the list and marks the selected campaign', () => {
    const state = screen([
      campaign(),
      campaign({ id: 'c-2', name: 'Waiting', state: 'ready', approved: false, audience: { total: 10, eligible: 9, excluded: 1 } }),
      campaign({ id: 'c-3', name: 'Later', state: 'scheduled', objective: null }),
      campaign({ id: 'c-4', name: 'Now', state: 'running' }),
    ]);
    state.live.selectedCampaignId = 'c-2';
    const root = renderBroadcasts(state);
    expect(Array.from(root.querySelectorAll('.kpi__value')).map((value) => value.textContent)).toEqual(['4', '1', '1', '1']);
    expect(root.querySelector('tr[aria-current="true"]')?.getAttribute('data-campaign')).toBe('c-2');
    expect(root.querySelector('[data-campaign="c-3"]')?.textContent).toContain('No objective');
    expect(root.querySelector('[data-campaign="c-1"]')?.textContent).toContain('Not frozen');
    expect(root.querySelector('[data-campaign-detail]')?.getAttribute('data-campaign-detail')).toBe('c-2');
  });

  it('opens the first campaign when none is selected, and the page’s refusal only when no dialog shows it', () => {
    const state = screen([campaign()]);
    state.live.error = { code: 'campaign_edit_locked', message: 'Locked.', requestId: 'r-4', status: 409, details: [] };
    const root = renderBroadcasts(state);
    expect(root.querySelector('[data-campaign-detail]')?.getAttribute('data-campaign-detail')).toBe('c-1');
    expect(root.querySelector('.page__inner > [role="alert"]')?.textContent).toContain('r-4');
    state.dialog = { kind: 'campaign', arg: '' };
    expect(renderBroadcasts(state).querySelector('.page__inner > [role="alert"]')).toBeNull();
  });
});

describe('the lifecycle offered for each state', () => {
  it('drafts: freeze, edit, test and clone', () => {
    expect(actions(screen([campaign()]))).toEqual(['live-campaign-validate', 'live-campaign-editor', 'campaign-test-send', 'live-campaign-clone']);
  });

  it('ready but unapproved: approve; approved: launch now or schedule', () => {
    expect(actions(screen([campaign({ state: 'ready' })]))).toEqual(['live-campaign-approve', 'live-campaign-editor', 'campaign-test-send', 'live-campaign-clone']);
    expect(actions(screen([campaign({ state: 'ready', approved: true })]))).toEqual(['live-campaign-launch', 'campaign-schedule', 'live-campaign-editor', 'campaign-test-send', 'live-campaign-clone']);
  });

  it('sending: pause and cancel; paused: resume and cancel; scheduled: cancel', () => {
    const execution = { id: 'e', state: 'running', scheduled_for: null };
    expect(actions(screen([campaign({ state: 'running', approved: true, execution })]))).toEqual(['control:pause', 'control:cancel', 'live-campaign-clone', 'campaign-report']);
    expect(actions(screen([campaign({ state: 'paused', approved: true, execution })]))).toEqual(['control:resume', 'control:cancel', 'live-campaign-clone', 'campaign-report']);
    expect(actions(screen([campaign({ state: 'scheduled', approved: true, execution: { id: 'e', state: 'scheduled', scheduled_for: '2026-09-10T09:00:00.000Z' } })]))).toEqual(['control:cancel', 'live-campaign-clone', 'campaign-report']);
  });

  it('finished or failed: retry the failed recipients only', () => {
    const execution = { id: 'e', state: 'dispatch_completed', scheduled_for: null };
    expect(actions(screen([campaign({ state: 'dispatch_completed', approved: true, execution })]))).toEqual(['live-campaign-retry', 'live-campaign-clone', 'campaign-report']);
    expect(actions(screen([campaign({ state: 'failed', approved: true, execution })]))).toEqual(['live-campaign-retry', 'live-campaign-clone', 'campaign-report']);
  });

  it('offers nothing a membership’s keys do not allow', () => {
    expect(actions(screen([campaign({ state: 'ready', approved: true, execution: { id: 'e', state: 'x', scheduled_for: null } })], ['campaign.read']))).toEqual([]);
    expect(actions(screen([campaign({ state: 'ready' })], ['campaign.read', 'campaign.approve']))).toEqual(['live-campaign-approve']);
  });

  it('marks the one in flight busy', () => {
    const state = screen([campaign()]);
    state.live.busy = 'campaign-validate:c-1';
    expect((renderBroadcasts(state).querySelector('[data-act="live-campaign-validate"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the detail', () => {
  it('walks the steps the server record has reached', () => {
    const state = screen([campaign({ state: 'ready', approved: true, audience: { total: 1280, eligible: 1146, excluded: 134 } })]);
    const root = renderBroadcasts(state);
    const steps = Array.from(root.querySelectorAll('.steps__item'));
    expect(steps.map((step) => step.className.includes('done'))).toEqual([true, true, true, false, false]);
    expect(steps[3]?.getAttribute('aria-current')).toBe('step');
    expect(root.querySelector('.validation')?.textContent).toContain('1,146');
    expect(root.textContent).toContain('Admissions · WhatsApp');
    expect(root.textContent).toContain('Not launched');
  });

  it('says the audience is not frozen, and names a channel it cannot find as absent', () => {
    const state = screen([campaign({ connection_id: 'cn-gone' })]);
    const root = renderBroadcasts(state);
    expect(root.querySelector('.validation--pending')?.textContent).toContain('Audience not frozen');
    expect(root.querySelector('.attrgrid')?.textContent).toContain('—');
  });

  it('shows when a scheduled launch will happen, and an execution’s state otherwise', () => {
    const scheduled = screen([campaign({ state: 'scheduled', execution: { id: 'e', state: 'scheduled', scheduled_for: '2026-09-10T09:00:00.000Z' } })]);
    expect(renderBroadcasts(scheduled).querySelector('.attrgrid')?.textContent).toContain('2026');
    const done = screen([campaign({ state: 'dispatch_completed', approved: true, audience: { total: 2, eligible: 2, excluded: 0 }, execution: { id: 'e', state: 'dispatch_completed', scheduled_for: null } })]);
    expect(renderBroadcasts(done).querySelector('.attrgrid')?.textContent).toContain('Sent');
    expect(Array.from(renderBroadcasts(done).querySelectorAll('.steps__item--done'))).toHaveLength(5);
  });
});

describe('the recipient ledger', () => {
  const execution = { id: 'e', state: 'running', scheduled_for: null };

  it('is absent before launch, and asked for when a launched campaign is opened', () => {
    expect(renderBroadcasts(screen([campaign()])).querySelector('.ledger')).toBeNull();
    const state = screen([campaign({ state: 'running', execution })]);
    expect(renderBroadcasts(state).querySelector('.ledger [data-act="live-campaign-open"]')).not.toBeNull();
  });

  it('shows loading, refusal, emptiness and rows with their reasons', () => {
    const state = screen([campaign({ state: 'running', execution })]);
    state.live.selectedCampaignId = 'c-1';
    state.live.campaignRecipients = { status: 'loading' };
    expect(renderBroadcasts(state).querySelector('.ledger [aria-busy="true"]')).not.toBeNull();
    state.live.campaignRecipients = { status: 'idle' };
    expect(renderBroadcasts(state).querySelector('.ledger [aria-busy="true"]')).not.toBeNull();
    state.live.campaignRecipients = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r-7', status: 500, details: [] } };
    expect(renderBroadcasts(state).querySelector('.ledger')?.textContent).toContain('r-7');
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [] };
    expect(renderBroadcasts(state).querySelector('.ledger')?.textContent).toContain('No recipients');

    const rows: CampaignRecipient[] = [
      { id: 'r1', contact_id: 'k', display_name: 'Mona', external_id: '2010', state: 'failed', last_error: { code: 'provider_rejected' }, estimated_amount_minor: '12.5', currency: 'USD' },
      { id: 'r2', contact_id: 'k', display_name: 'Omar', external_id: '2011', state: 'delivered', last_error: null, estimated_amount_minor: null, currency: null },
      { id: 'r3', contact_id: 'k', display_name: 'Lina', external_id: '2012', state: 'weird', last_error: null, estimated_amount_minor: '1', currency: null },
    ];
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: rows };
    const ledger = renderBroadcasts(state).querySelector('.ledger') as HTMLElement;
    expect(ledger.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(ledger.textContent).toContain('Rejected by provider');
    expect(ledger.textContent).toContain('12.5 USD');
    expect(ledger.querySelectorAll('tbody tr')[2]?.querySelector('.badge--neutral')?.textContent).toBe('weird');
  });

  it('reads a typed error code out of a ledger error, and nothing out of anything else', () => {
    expect(errorCodeOf({ code: 'window_closed' })).toBe('window_closed');
    expect(errorCodeOf({ code: 7 })).toBeNull();
    expect(errorCodeOf('provider_rejected')).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
  });
});

it('speaks Arabic by default', () => {
  const root = renderBroadcasts(screen([campaign()], ALL, 'ar'));
  expect(root.textContent).toContain('تثبيت الجمهور');
  expect(root.textContent).toContain('مسودة');
});

describe('broadcasts sorted by where they are in their life', () => {
  it('buckets every lifecycle state', () => {
    const buckets = (['draft', 'validating', 'ready', 'scheduled', 'running', 'pausing', 'paused', 'cancelling', 'dispatch_completed', 'cancelled', 'failed'] as const)
      .map((state) => campaignBucket(state));
    expect(buckets).toEqual(['drafts', 'drafts', 'drafts', 'scheduled', 'sending', 'sending', 'sending', 'sending', 'completed', 'completed', 'completed']);
  });

  it('counts each bucket, shows only the chosen one, and says when it is empty', () => {
    const state = screen([
      campaign({ id: 'c-1', state: 'draft' }),
      campaign({ id: 'c-2', name: 'Sunday reminder', state: 'scheduled', content: { type: 'template', template: { id: 't-1', name: 'class_reminder', language: 'ar' } } }),
    ]);
    const counts = [...renderBroadcasts(state).querySelectorAll('.campaign-views .segmented__item')].map((item) => item.textContent);
    expect(counts).toEqual(['All2', 'Drafts1', 'Scheduled1', 'Sending0', 'Completed0']);
    state.live.campaignView = 'scheduled';
    const scheduled = renderBroadcasts(state);
    expect([...scheduled.querySelectorAll('[data-campaign]')].map((row) => row.getAttribute('data-campaign'))).toEqual(['c-2']);
    // A broadcast names the template it sends.
    expect(scheduled.querySelector('.campaign-detail__template')?.textContent).toBe('class_reminder · ar');
    state.live.campaignView = 'completed';
    expect(renderBroadcasts(state).textContent).toContain('No broadcast is in this group.');
    state.live.campaignView = 'all';
    expect(renderBroadcasts(state).querySelector('.campaign-detail')?.textContent).toContain('Hi');
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [campaign({ content: { text: 'x'.repeat(90) } })] };
    expect(renderBroadcasts(state).querySelector('.campaign-detail')?.textContent).toContain(`${'x'.repeat(80)}…`);
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [campaign({ content: { template: { id: 't-9' } } })] };
    expect(renderBroadcasts(state).querySelector('.campaign-detail__template')?.textContent).toBe('— · ');
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [campaign({ content: {} })] };
    expect(renderBroadcasts(state).querySelector('.campaign-detail')?.textContent).toContain('Message—');
  });

  it('asks for a WhatsApp number before anything can be broadcast', () => {
    const state = screen([]);
    state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
    const empty = renderBroadcasts(state);
    expect(empty.textContent).toContain('Connect a WhatsApp Business number');
    expect(empty.querySelector('.empty [data-act="nav"]')?.getAttribute('data-arg')).toBe('channels');
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [campaign()] };
    expect(renderBroadcasts(state).querySelector('.notice')?.textContent).toContain('No WhatsApp number is connected');
  });
});

describe('saved audiences', () => {
  const LABEL = '11111111-1111-4111-8111-111111111111';

  it('lists what each audience narrows to, and offers to add and remove them', () => {
    const state = screen([campaign()]);
    state.live.campaignView = 'audiences';
    state.live.audiences = { status: 'loading' };
    expect(renderBroadcasts(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.audiences = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r-9', status: 500, details: [] } };
    expect(renderBroadcasts(state).textContent).toContain('r-9');
    state.live.audiences = { status: 'ready', loadedAt: 1, value: [] };
    const empty = renderBroadcasts(state);
    expect(empty.textContent).toContain('No saved audiences');
    // Offered in the header and in the empty state.
    expect(empty.querySelectorAll('[data-act="live-audience-new"]')).toHaveLength(2);
    expect(empty.querySelector('.empty [data-act="live-audience-new"]')).not.toBeNull();
    state.live.labels = { status: 'ready', loadedAt: 1, value: [{ id: LABEL, name: 'VIP', color: '#2563eb', state: 'active', version: 1 }] };
    state.live.audiences = { status: 'ready', loadedAt: 1, value: [
      { id: 'a-1', name: 'VIPs', description: null, state: 'active', version: 1, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [
        { kind: 'predicate', field: 'label_id', operator: 'eq', value: LABEL },
        { kind: 'predicate', field: 'label_id', operator: 'eq', value: 'gone' },
        { kind: 'predicate', field: 'conversation_label_id', operator: 'in', value: [LABEL] },
        { kind: 'predicate', field: 'contact_id', operator: 'in', value: ['c-1', 'c-2'] },
        { kind: 'predicate', field: 'customer_name', operator: 'contains', value: 'mo' },
      ] } } },
      { id: 'a-2', name: 'Odd', description: null, state: 'active', version: 1, conditions: { version: 1, root: { kind: 'group', match: 'any', conditions: [] } } },
      { id: 'a-3', name: 'Everyone', description: null, state: 'active', version: 1, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [] } } },
    ] };
    state.live.busy = 'audience-retire:a-2';
    const list = renderBroadcasts(state);
    const cards = [...list.querySelectorAll('.audience-card')];
    expect(cards[0]?.textContent).toContain('Labels: VIP, … · Conversations labelled: VIP · 2 people picked · Name contains “mo”');
    expect(cards[1]?.textContent).toContain('Conditions a broadcast cannot apply');
    expect(cards[1]?.querySelector('[data-act="live-audience-retire"]')?.getAttribute('aria-busy')).toBe('true');
    expect(cards[2]?.querySelector('.audience-card__text > span')?.textContent).toBe('');
    state.lang = 'ar';
    expect(renderBroadcasts(state).querySelector('.audience-card')?.textContent).toContain('تصنيفات: VIP، …');
    // Without the draft key, nothing can be added or removed.
    const reader = screen([], ['campaign.read']);
    reader.live.campaignView = 'audiences';
    reader.live.audiences = state.live.audiences;
    const readOnly = renderBroadcasts(reader);
    expect(readOnly.querySelector('[data-act="live-audience-retire"]')).toBeNull();
    reader.live.audiences = { status: 'ready', loadedAt: 1, value: [] };
    expect(renderBroadcasts(reader).querySelector('[data-act="live-audience-new"]')).toBeNull();
  });
});
