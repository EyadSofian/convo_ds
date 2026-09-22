import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult } from '../api/client.js';
import type { ConversationsApi, SupervisorAgent, SupervisorWorkload } from '../api/conversations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadSupervisorAgents, loadSupervisorInbox, refreshSupervisorWorkload } from './inbox-actions.js';

const ERROR: ApiError = { code: 'refused', message: 'No', requestId: 'r', status: 403, details: [] };
const AGENT: SupervisorAgent = { membershipId: 'agent-1', name: 'Ahmed', email: 'ahmed@test.local', teams: ['Sales'] };
const WORKLOAD: SupervisorWorkload = { agent: AGENT, current: { assigned: 0, open: 0, pending: 0, snoozed: 0, unreplied: 0, urgent: 0, high: 0 }, byStatus: [], byChannel: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T = never>(): ApiResult<T> => ({ ok: false, error: ERROR });

function setup() {
  const state = createState(new Date('2026-09-17T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
  const conversations = {
    supervisorAgents: vi.fn().mockResolvedValue(ok([AGENT])),
    supervisorList: vi.fn().mockResolvedValue(ok({ items: [], nextCursor: null })),
    supervisorWorkload: vi.fn().mockResolvedValue(ok(WORKLOAD)),
  } as unknown as ConversationsApi;
  Object.defineProperty(state.live, 'conversationsApi', { value: conversations });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, conversations };
}

describe('supervisor inbox actions', () => {
  it('loads the scoped agent directory and preserves a refusal', async () => {
    const app = setup();
    await loadSupervisorAgents(app.context);
    expect(app.state.live.supervisorAgents).toMatchObject({ status: 'ready', value: [AGENT] });
    const refused = setup();
    vi.mocked(refused.conversations.supervisorAgents).mockResolvedValueOnce(fail());
    await loadSupervisorAgents(refused.context);
    expect(refused.state.live.error).toEqual(ERROR);
  });

  it('requires an allowed agent, then loads list and workload under supervisor scope', async () => {
    const app = setup();
    app.state.live.supervisorAgents = { status: 'ready', value: [AGENT], loadedAt: 1 };
    expect(await loadSupervisorInbox(app.context, 'missing')).toBe(false);
    expect(await loadSupervisorInbox(app.context, AGENT.membershipId)).toBe(true);
    expect(app.conversations.supervisorList).toHaveBeenCalledWith('tenant-1', AGENT.membershipId, expect.objectContaining({ cursor: null }));
    expect(app.state.live.supervisorWorkload).toMatchObject({ status: 'ready', value: WORKLOAD });
    const refused = setup();
    refused.state.live.supervisorAgents = { status: 'ready', value: [AGENT], loadedAt: 1 };
    vi.mocked(refused.conversations.supervisorList).mockResolvedValueOnce(fail());
    expect(await loadSupervisorInbox(refused.context, AGENT.membershipId)).toBe(false);
    expect(refused.state.live.error).toEqual(ERROR);
  });

  it('refreshes only the selected workload and reports server refusal', async () => {
    const app = setup();
    app.state.live.supervisorAgentId = AGENT.membershipId;
    await refreshSupervisorWorkload(app.context);
    expect(app.conversations.supervisorWorkload).toHaveBeenCalledWith('tenant-1', AGENT.membershipId);
    const refused = setup();
    refused.state.live.supervisorAgentId = AGENT.membershipId;
    vi.mocked(refused.conversations.supervisorWorkload).mockResolvedValueOnce(fail());
    await refreshSupervisorWorkload(refused.context);
    expect(refused.state.live.error).toEqual(ERROR);
    const absent = setup();
    await refreshSupervisorWorkload(absent.context);
    expect(absent.conversations.supervisorWorkload).not.toHaveBeenCalled();
  });
});
