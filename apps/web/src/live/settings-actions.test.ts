import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { ApiResult } from '../api/client.js';
import { loadSettingsScreen, type LiveContext } from './actions.js';

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

function setup(tenantId: string | null) {
  const state = createState(new Date('2026-09-17T00:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId };
  const sessions = vi.fn().mockResolvedValue(ok([]));
  const labels = vi.fn().mockResolvedValue(ok([]));
  Object.defineProperty(state.live.api, 'sessions', { value: sessions });
  Object.defineProperty(state.live.metadataApi, 'labels', { value: labels });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, sessions, labels };
}

describe('settings screen loading', () => {
  it('loads sessions without asking for workspace labels when no tenant is selected', async () => {
    const app = setup(null);
    await loadSettingsScreen(app.context);
    expect(app.sessions).toHaveBeenCalledOnce();
    expect(app.labels).not.toHaveBeenCalled();
    expect(app.state.live.sessions).toMatchObject({ status: 'ready', value: [] });
  });

  it('loads the workspace label catalogue for an active tenant', async () => {
    const app = setup('tenant-1');
    await loadSettingsScreen(app.context);
    expect(app.labels).toHaveBeenCalledWith('tenant-1', true);
    expect(app.state.live.workspaceLabels).toMatchObject({ status: 'ready', value: [] });
  });
});
