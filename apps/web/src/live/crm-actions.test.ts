import { describe, expect, it, vi } from 'vitest';
import type { CrmSettings, CreatedCrmKey } from '../api/crm.js';
import type { ApiResult } from '../api/client.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { createCrmKey, loadCrmSettings } from './crm-actions.js';
import { renewLiveState } from './store.js';

const key = { id: 'key', label: 'CRM', connection_ids: ['sender'], expires_at: '2027-01-01T00:00:00Z' };
const settings = {
  tenantId: 'tenant', keys: [key],
  senders: [{ id: 'sender', displayName: 'Sales', phoneNumberId: '1', displayPhoneNumber: null, sendReady: true }],
} satisfies CrmSettings;
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

function setup() {
  const state = createState(new Date('2026-11-24T00:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'admin@crm.test', memberships: [], tenantId: 'tenant' };
  state.live.crmSettings = { status: 'ready', value: settings, loadedAt: 1 };
  state.dialog = { kind: 'crm-key', arg: '' };
  state.dialogForm = { crmLabel: 'CRM', crmSender_sender: 'yes' };
  const get = vi.spyOn(state.live.api, 'crmSettings').mockResolvedValue(ok(settings));
  const create = vi.spyOn(state.live.api, 'createCrmKey');
  const context: LiveContext = {
    state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'x',
    endSession: vi.fn(), switchWorkspace: vi.fn(),
  };
  return { state, context, get, create };
}

describe('CRM settings request lifecycle', () => {
  it('keeps only the latest read of the current workspace', async () => {
    const app = setup();
    let complete!: (value: ApiResult<CrmSettings>) => void;
    app.get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const old = loadCrmSettings(app.context);
    await loadCrmSettings(app.context);
    complete(ok({ ...settings, keys: [] }));
    await old;
    expect(app.state.live.crmSettings).toMatchObject({ status: 'ready', value: { keys: [key] } });

    app.get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = loadCrmSettings(app.context);
    app.state.live = renewLiveState(app.state.live);
    complete(ok(settings));
    await pending;
    expect(app.state.live.crmSettings.status).toBe('idle');
  });

  it('never reveals a key in a closed dialog or a different workspace', async () => {
    const app = setup();
    let complete!: (value: ApiResult<CreatedCrmKey>) => void;
    app.create.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = createCrmKey(app.context);
    await createCrmKey(app.context);
    expect(app.create).toHaveBeenCalledOnce();
    app.state.dialog = null;
    app.state.dialogForm = {};
    complete(ok({ key, token: 'one-time' }));
    await pending;
    expect(app.state.dialogForm).toEqual({});

    app.state.dialog = { kind: 'crm-key', arg: '' };
    app.state.dialogForm = { crmLabel: 'CRM', crmSender_sender: 'yes' };
    const stale = createCrmKey(app.context);
    app.state.live = renewLiveState(app.state.live);
    complete(ok({ key, token: 'old-workspace' }));
    await stale;
    expect(app.state.dialogForm['crmToken']).toBeUndefined();
  });
});
