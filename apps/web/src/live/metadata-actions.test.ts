import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult } from '../api/client.js';
import type { Label, MetadataApi } from '../api/metadata.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { createField, createLabel, createAndAssignLabel, retireLabel, updateLabel } from './metadata-actions.js';

const ERROR: ApiError = { code: 'refused', message: 'No', requestId: 'r', status: 409, details: [] };
const LABEL: Label = { id: 'label-1', name: 'VIP', color: '#123456', state: 'active', version: 2 };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T = never>(): ApiResult<T> => ({ ok: false, error: ERROR });

function setup() {
  const state = createState(new Date('2026-09-17T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
  state.live.workspaceLabels = { status: 'ready', value: [LABEL], loadedAt: 1 };
  const metadata = {
    labels: vi.fn().mockResolvedValue(ok([LABEL])),
    fields: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok(LABEL)),
    updateLabel: vi.fn().mockResolvedValue(ok({ ...LABEL, name: 'VIP+' })),
    retireLabel: vi.fn().mockResolvedValue(ok({ ...LABEL, state: 'retired' as const })),
    createField: vi.fn().mockResolvedValue(ok({ id: 'field-1' })),
    contact: vi.fn(),
    conversation: vi.fn(),
  } as unknown as MetadataApi;
  Object.defineProperty(state.live, 'metadataApi', { value: metadata });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, metadata };
}

describe('metadata actions', () => {
  it('creates labels and fields only after server confirmation', async () => {
    const app = setup();
    expect(await createLabel(app.context, 'VIP', '#123456')).toBe(true);
    expect(app.metadata.createLabel).toHaveBeenCalledWith('tenant-1', 'VIP', '#123456');
    expect(await createField(app.context, { target: 'contact', key: 'plan', name: 'Plan', type: 'text', options: [] })).toBe(true);
    expect(app.metadata.createField).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ key: 'plan' }));
    const refused = setup();
    vi.mocked(refused.metadata.createLabel).mockResolvedValueOnce(fail());
    expect(await createLabel(refused.context, 'No', '#000000')).toBe(false);
    expect(refused.state.live.error).toEqual(ERROR);
    vi.mocked(refused.metadata.createField).mockResolvedValueOnce(fail());
    expect(await createField(refused.context, { target: 'contact', key: 'x', name: 'X', type: 'text', options: [] })).toBe(false);
  });

  it('updates and retires labels in the workspace catalogue', async () => {
    const app = setup();
    expect(await updateLabel(app.context, LABEL, 'VIP+', '#654321')).toBe(true);
    expect(app.state.live.workspaceLabels).toMatchObject({ status: 'ready', value: [{ id: 'label-1', name: 'VIP+' }] });
    expect(await retireLabel(app.context, LABEL)).toBe(true);
    expect(app.state.live.workspaceLabels).toMatchObject({ status: 'ready', value: [{ id: 'label-1', state: 'retired' }] });
    const refused = setup();
    vi.mocked(refused.metadata.updateLabel).mockResolvedValueOnce(fail());
    expect(await updateLabel(refused.context, LABEL, 'No', '#000000')).toBe(false);
    vi.mocked(refused.metadata.retireLabel).mockResolvedValueOnce(fail());
    expect(await retireLabel(refused.context, LABEL)).toBe(false);
  });

  it('rejects inline assignment without a loaded entity version', async () => {
    const app = setup();
    expect(await createAndAssignLabel(app.context, 'conversation', 'missing', 'VIP', '#123456')).toBe(false);
    expect(app.metadata.createLabel).not.toHaveBeenCalled();
  });
});
