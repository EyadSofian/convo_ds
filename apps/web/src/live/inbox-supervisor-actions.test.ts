import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult } from '../api/client.js';
import type { ConversationsApi, SupervisorAgent, SupervisorWorkload } from '../api/conversations.js';
import type { RealtimeEvent } from './realtime.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { applyRealtimeEvent, loadInboxScreen, loadMoreInbox, loadSupervisorAgents, loadSupervisorInbox, refreshSupervisorWorkload } from './inbox-actions.js';

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
    unassigned: vi.fn().mockResolvedValue(ok([])),
    list: vi.fn().mockResolvedValue(ok({ items: [], nextCursor: null })),
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

    const workloadRefused = setup();
    workloadRefused.state.live.supervisorAgents = { status: 'ready', value: [AGENT], loadedAt: 1 };
    vi.mocked(workloadRefused.conversations.supervisorWorkload).mockResolvedValueOnce(fail());
    expect(await loadSupervisorInbox(workloadRefused.context, AGENT.membershipId)).toBe(true);
    expect(workloadRefused.state.live.error).toEqual(ERROR);
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

  it('restores a valid supervisor lens from the URL and records page or workload failures', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const app = setup();
    app.state.route = { screen: 'inbox', conversationId: null, params: { agent: agentId } };
    await loadInboxScreen(app.context);
    expect(app.state.live.supervisorAgentId).toBe(agentId);
    expect(app.conversations.supervisorList).toHaveBeenCalledWith('tenant-1', agentId, expect.objectContaining({ cursor: null }));
    expect(app.conversations.supervisorWorkload).toHaveBeenCalledWith('tenant-1', agentId);

    const pageFailure = setup();
    pageFailure.state.live.supervisorAgentId = agentId;
    vi.mocked(pageFailure.conversations.supervisorList).mockResolvedValueOnce(fail());
    await loadInboxScreen(pageFailure.context);
    expect(pageFailure.state.live.conversations).toMatchObject({ status: 'error', error: ERROR });

    const workloadFailure = setup();
    workloadFailure.state.live.supervisorAgentId = agentId;
    vi.mocked(workloadFailure.conversations.supervisorWorkload).mockResolvedValueOnce(fail());
    await loadInboxScreen(workloadFailure.context);
    expect(workloadFailure.state.live.supervisorWorkload).toMatchObject({ status: 'error', error: ERROR });
  });

  it('loads the regular inbox and keeps cursor continuation scoped and deduplicated', async () => {
    const app = setup();
    app.state.live.labels = { status: 'ready', value: [], loadedAt: 1 };
    app.state.live.savedViews = { status: 'ready', value: [], loadedAt: 1 };
    app.state.live.people = { status: 'ready', value: [], loadedAt: 1 };
    app.state.live.teams = { status: 'ready', value: [], loadedAt: 1 };
    app.state.live.connections = { status: 'ready', value: [], loadedAt: 1 };
    app.state.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
    vi.mocked(app.conversations.list).mockResolvedValueOnce(ok({ items: [], nextCursor: 'first' }));
    await loadInboxScreen(app.context);
    expect(app.state.live.inboxNextCursor).toBe('first');

    app.state.live.conversations = { status: 'ready', value: [{ id: 'same' } as never], loadedAt: 1 };
    app.state.live.inboxNextCursor = 'next';
    vi.mocked(app.conversations.list).mockResolvedValueOnce(ok({ items: [{ id: 'same' }, { id: 'new' }] as never[], nextCursor: null }));
    await loadMoreInbox(app.context);
    expect(app.conversations.list).toHaveBeenLastCalledWith('tenant-1', expect.objectContaining({ cursor: 'next' }));
    expect(app.state.live.conversations).toMatchObject({ status: 'ready', value: [{ id: 'same' }, { id: 'new' }] });
    expect(app.state.live.inboxNextCursor).toBeNull();

    app.state.live.inboxNextCursor = 'failed';
    vi.mocked(app.conversations.list).mockResolvedValueOnce(fail());
    await loadMoreInbox(app.context);
    expect(app.state.live.error).toEqual(ERROR);
    app.state.live.busy = 'other';
    const calls = vi.mocked(app.conversations.list).mock.calls.length;
    await loadMoreInbox(app.context);
    expect(app.conversations.list).toHaveBeenCalledTimes(calls);

    const failedFirstPage = setup();
    failedFirstPage.state.live.labels = { status: 'ready', value: [], loadedAt: 1 };
    failedFirstPage.state.live.savedViews = { status: 'ready', value: [], loadedAt: 1 };
    failedFirstPage.state.live.people = { status: 'ready', value: [], loadedAt: 1 };
    failedFirstPage.state.live.teams = { status: 'ready', value: [], loadedAt: 1 };
    failedFirstPage.state.live.connections = { status: 'ready', value: [], loadedAt: 1 };
    failedFirstPage.state.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
    vi.mocked(failedFirstPage.conversations.list).mockResolvedValueOnce(fail());
    await loadInboxScreen(failedFirstPage.context);
    expect(failedFirstPage.state.live.conversations).toMatchObject({ status: 'error', error: ERROR });
    expect(failedFirstPage.state.live.inboxNextCursor).toBeNull();
  });

  it('loads supervisor cursor pages only for the selected membership', async () => {
    const app = setup();
    app.state.live.supervisorAgentId = AGENT.membershipId;
    app.state.live.inboxNextCursor = 'cursor';
    vi.mocked(app.conversations.supervisorList).mockResolvedValueOnce(ok({ items: [], nextCursor: null }));
    await loadMoreInbox(app.context);
    expect(app.conversations.supervisorList).toHaveBeenCalledWith('tenant-1', AGENT.membershipId, expect.objectContaining({ cursor: 'cursor' }));
    expect(app.conversations.list).not.toHaveBeenCalled();
  });

  it('refreshes supervisor workload for ownership changes but not message-only events', async () => {
    const app = setup();
    app.state.live.supervisorAgentId = AGENT.membershipId;
    const event = (type: string) => ({
      schemaVersion: 1, id: `event-${type}`, seq: 1, type,
      entity: { type: 'conversation', id: 'conversation-1', version: 1 },
      scope: { conversationId: 'conversation-1', inboxId: 'inbox-1', teamId: null, assigneeMembershipId: AGENT.membershipId },
      occurredAt: new Date(1).toISOString(), payload: {},
    }) as RealtimeEvent;
    await applyRealtimeEvent(app.context, event('message.inbound'));
    expect(app.conversations.supervisorWorkload).not.toHaveBeenCalled();
    await applyRealtimeEvent(app.context, event('conversation.assigned'));
    expect(app.conversations.supervisorWorkload).toHaveBeenCalledWith('tenant-1', AGENT.membershipId);
    expect(app.conversations.supervisorList).toHaveBeenCalledTimes(2);
  });
});
