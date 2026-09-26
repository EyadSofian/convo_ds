import { describe, expect, it } from 'vitest';
import type { ConditionDocument } from '@convo/domain';
import type { Campaign } from '../api/campaigns.js';
import type { SavedAudience } from '../api/saved-views.js';
import { createState } from '../state.js';
import {
  audienceDraft,
  audienceGap,
  conditionsFromFilter,
  editorAudience,
  filterFromConditions,
  filterOf,
  idList,
  previewKey,
  sourceOf,
  toggled,
} from './audience.js';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';

function saved(id: string, conditions: ConditionDocument): SavedAudience {
  return { id, name: id, description: null, conditions, state: 'active', version: 1 };
}

describe('lists in the form', () => {
  it('reads a comma list without blanks or repeats, and toggles one id', () => {
    expect(idList(` ${L1}, ,${L2},${L1} `)).toEqual([L1, L2]);
    expect(idList('')).toEqual([]);
    expect(toggled([L1], L2)).toBe(`${L1},${L2}`);
    expect(toggled([L1, L2], L1)).toBe(L2);
  });
});

describe('the audience draft', () => {
  it('opens an existing filter on the source it came from', () => {
    expect(sourceOf({})).toBe('all');
    expect(sourceOf({ labelIds: [L1] })).toBe('labels');
    expect(sourceOf({ labelIds: [], conversationLabelIds: [L2] })).toBe('conversations');
    expect(sourceOf({ contactIds: [C1], labelIds: [L1] })).toBe('picked');
  });

  it('prefers what was typed and falls back to what the draft holds', () => {
    const initial = { search: 'Mona', labelIds: [L1] };
    expect(audienceDraft({}, initial)).toEqual({ source: 'labels', search: 'Mona', labelIds: [L1], conversationLabelIds: [], contactIds: [], savedId: '' });
    expect(audienceDraft({ campaignAudienceSource: 'picked', campaignContactIds: C1, campaignSearch: '', campaignLabelIds: '', campaignSavedAudience: 'a-1' }, initial))
      .toEqual({ source: 'picked', search: '', labelIds: [], conversationLabelIds: [], contactIds: [C1], savedId: 'a-1' });
    expect(audienceDraft({ campaignAudienceSource: 'nowhere' }, {}).source).toBe('all');
  });
});

describe('the filter a draft names', () => {
  const base = { search: '  ', labelIds: [L1], conversationLabelIds: [L2], contactIds: [C1], savedId: '' };
  it('keeps only the chosen source, and a name narrowing on any of them', () => {
    expect(filterOf({ ...base, source: 'all' }, [])).toEqual({});
    expect(filterOf({ ...base, source: 'labels', search: ' Sa ' }, [])).toEqual({ search: 'Sa', labelIds: [L1] });
    expect(filterOf({ ...base, source: 'conversations' }, [])).toEqual({ conversationLabelIds: [L2] });
    expect(filterOf({ ...base, source: 'picked' }, [])).toEqual({ contactIds: [C1] });
  });

  it('reads a saved audience, or nothing when none usable is chosen', () => {
    const usable = saved('a-1', conditionsFromFilter({ labelIds: [L1] }) as ConditionDocument);
    expect(filterOf({ ...base, source: 'saved', savedId: 'a-1' }, [usable])).toEqual({ labelIds: [L1] });
    expect(filterOf({ ...base, source: 'saved', savedId: 'missing' }, [usable])).toBeNull();
  });

  it('names what is still missing before the audience means anything', () => {
    const empty = { search: '', labelIds: [], conversationLabelIds: [], contactIds: [], savedId: '' };
    expect(audienceGap({ ...empty, source: 'all' }, {})).toBeNull();
    expect(audienceGap({ ...empty, source: 'labels' }, {})).toBe('labels');
    expect(audienceGap({ ...empty, source: 'conversations' }, {})).toBe('conversations');
    expect(audienceGap({ ...empty, source: 'picked' }, {})).toBe('picked');
    expect(audienceGap({ ...empty, source: 'saved' }, null)).toBe('saved');
    expect(audienceGap({ ...empty, source: 'saved' }, {})).toBeNull();
    expect(audienceGap({ ...empty, source: 'labels', labelIds: [L1] }, {})).toBeNull();
  });
});

describe('saved audiences as condition documents', () => {
  it('round-trips every narrowing a campaign can apply', () => {
    const filter = { search: 'Sa', labelIds: [L1, L2], conversationLabelIds: [L2], contactIds: [C1] };
    const document = conditionsFromFilter(filter) as ConditionDocument;
    expect(document.root.conditions).toHaveLength(5);
    expect(filterFromConditions(document)).toEqual(filter);
    expect(filterFromConditions(conditionsFromFilter({ contactIds: [C1] }) as ConditionDocument)).toEqual({ contactIds: [C1] });
    expect(conditionsFromFilter({})).toBeNull();
    expect(conditionsFromFilter({ labelIds: [], conversationLabelIds: [], contactIds: [] })).toBeNull();
  });

  it('refuses anything it would have to approximate', () => {
    const any: ConditionDocument = { version: 1, root: { kind: 'group', match: 'any', conditions: [{ kind: 'predicate', field: 'label_id', operator: 'eq', value: L1 }] } };
    const nested: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [any.root] } };
    const unknown: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'channel', operator: 'eq', value: 'whatsapp' }] } };
    const labelAny: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'label_id', operator: 'in', value: [L1] }] } };
    for (const document of [any, nested, unknown, labelAny]) expect(filterFromConditions(document)).toBeNull();
  });
});

describe('the editor audience', () => {
  it('describes the campaign being edited, or a new one on the first healthy channel', () => {
    const state = createState(new Date('2026-09-26T09:00:00.000Z'));
    state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'sick', status: 'degraded' }, { id: 'well', status: 'healthy' }] as never };
    state.dialog = { kind: 'campaign', arg: '' };
    expect(editorAudience(state)).toMatchObject({ connectionId: 'well', filter: {} });
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{ id: 'c-1', connection_id: 'sick', audience_filter: { contactIds: [C1] } } as unknown as Campaign] };
    state.dialog = { kind: 'campaign-edit', arg: 'c-1' };
    expect(editorAudience(state)).toMatchObject({ connectionId: 'sick', filter: { contactIds: [C1] }, draft: { source: 'picked' } });
    state.dialogForm = { campaignConnection: 'well' };
    expect(editorAudience(state).connectionId).toBe('well');
    state.dialog = { kind: 'campaign-edit', arg: 'gone' };
    state.live.connections = { status: 'idle' };
    state.dialogForm = {};
    expect(editorAudience(state)).toMatchObject({ connectionId: '', filter: {} });
    expect(previewKey('well', { search: 'a' })).toBe('well|{"search":"a"}');
  });
});
