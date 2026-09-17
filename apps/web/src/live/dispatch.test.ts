import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { LIVE_ACTIONS, roleNameField, splitArg, teamMemberField } from './dispatch.js';

/**
 * The naming rules the DOM and the dispatcher have to agree on.
 *
 * A form value reaches the dispatcher as `"<key>:<value>"`, so a key that
 * contains a colon stores the wrong thing under the wrong name — silently, and
 * only for the controls that happen to use one. These are the two places that
 * build such a key, and the one function that takes it apart again.
 */

describe('splitArg', () => {
  it('splits an id from its value', () => {
    expect(splitArg('m-1:supervisor')).toEqual({ id: 'm-1', value: 'supervisor' });
  });

  it('keeps everything after the first colon, because a value may contain one', () => {
    expect(splitArg('t-1:a:b')).toEqual({ id: 't-1', value: 'a:b' });
  });

  it('reads an argument with no separator as all id and no value', () => {
    // What a control rendered without a form key produces. Answering rather
    // than throwing keeps one malformed control from taking the screen down;
    // the empty value is then rejected by the parser on the server.
    expect(splitArg('t-1')).toEqual({ id: 't-1', value: '' });
    expect(splitArg('')).toEqual({ id: '', value: '' });
  });
});

describe('form keys', () => {
  it('never contain the separator the DOM uses', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(teamMemberField(id)).toBe(`teamMember_${id}`);
    expect(roleNameField(id)).toBe(`roleName_${id}`);
    expect(teamMemberField(id)).not.toContain(':');
    expect(roleNameField(id)).not.toContain(':');
  });
});

/**
 * The automation entries in the dispatch table.
 *
 * These are one-line adapters between a DOM `data-act` and an action, and that
 * is exactly why they are worth a test: nothing else checks that the name the
 * screen renders is the name the table answers to, or that the argument is
 * passed through in the shape the action expects. A typo in either is a button
 * that silently does nothing.
 */
describe('the automation actions the DOM can name', () => {
  function context() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    return {
      state,
      live: state.live,
      refresh: vi.fn(),
      now: () => 1,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as LiveContext;
  }

  it('registers the reload action, which loads rather than mutating', async () => {
    // It answers void rather than a boolean: there is nothing to confirm, and
    // with no workspace selected it declines to fetch at all.
    const handler = LIVE_ACTIONS['live-automations-reload'];
    expect(handler).toBeDefined();
    await expect(handler?.(context(), '')).resolves.toBeUndefined();
  });

  it.each([
    'live-automation-use',
    'live-automation-save',
    'live-automation-add-step',
    'live-automation-remove-step',
    'live-automation-transition',
  ])('registers %s and answers without throwing', async (name) => {
    // No workspace is selected, so every one of these declines rather than
    // acting — which is the property under test: the handler exists, runs, and
    // fails closed.
    const handler = LIVE_ACTIONS[name];
    expect(handler, `${name} is not registered`).toBeDefined();
    await expect(handler?.(context(), 'a-1:activate')).resolves.toBe(false);
  });

  it('refuses to create a blank automation with no name, and does not clear the form', async () => {
    const ctx = context();
    ctx.state.dialogForm = { automationBlankName: '   ' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
    // The operator's other typing survives a refused submit.
    expect(ctx.state.dialogForm['automationBlankName']).toBe('   ');
  });

  it('clears the form once the server has committed the new automation', async () => {
    // The dialog only empties after a confirmed create, so a refusal never
    // loses what the operator typed.
    const ctx = context();
    ctx.state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
    // A successful create reloads the screen, so every read the reload makes
    // has to answer too.
    const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
    Object.defineProperty(ctx.live, 'automationsApi', {
      value: {
        create: vi.fn().mockResolvedValue({ ok: true, data: { id: 'a-1' } }),
        templates: vi.fn(() => ok([])),
        whatsappTemplates: vi.fn(() => ok([])),
        list: vi.fn(() => ok([])),
        runs: vi.fn(() => ok([])),
      },
    });
    ctx.state.dialogForm = { automationBlankName: 'Welcome flow' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(true);
    expect(ctx.state.dialogForm).toEqual({});
  });

  it('declines when the dialog has no name field at all', async () => {
    const ctx = context();
    ctx.state.dialogForm = {};
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
  });

  it('keeps the form when creation is declined by the server', async () => {
    const ctx = context();
    ctx.state.dialogForm = { automationBlankName: 'Welcome flow' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.state.dialogForm['automationBlankName']).toBe('Welcome flow');
  });
});

describe('public credential actions', () => {
  function context() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.route = { screen: 'reset-password', conversationId: null, params: { token: 't'.repeat(43) } };
    const refresh = vi.fn();
    return {
      state,
      live: state.live,
      refresh,
      now: () => 1,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as LiveContext;
  }

  it('validates and submits an enumeration-safe recovery request', async () => {
    const ctx = context();
    const requestRecovery = vi.fn().mockResolvedValue({ ok: true, data: { status: 'accepted', message: 'ok' } });
    Object.defineProperty(ctx.live, 'api', { value: { requestRecovery } });
    ctx.state.dialogForm = { recoveryEmail: 'bad' };
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(requestRecovery).not.toHaveBeenCalled();
    ctx.state.dialogForm = { recoveryEmail: 'person@example.test' };
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(true);
    expect(requestRecovery).toHaveBeenCalledWith('person@example.test');
    expect(ctx.state.authFlowComplete).toBe('recovery-request');
    requestRecovery.mockResolvedValueOnce({ ok: false, error: { code: 'down', message: 'down', requestId: null, status: 503, details: [] } });
    ctx.live.busy = null;
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.live.error?.code).toBe('down');
    ctx.live.busy = 'something';
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
  });

  it('keeps typed recovery credentials on validation errors and clears them after a server attempt', async () => {
    const ctx = context();
    const completeRecovery = vi.fn().mockResolvedValue({ ok: false, error: { code: 'expired', message: 'expired', requestId: null, status: 400, details: [] } });
    Object.defineProperty(ctx.live, 'api', { value: { completeRecovery } });
    ctx.state.route = { ...ctx.state.route, params: {} };
    ctx.state.dialogForm = {};
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    ctx.state.dialogForm = { authPassword: 'short', authPasswordConfirm: 'different' };
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(completeRecovery).not.toHaveBeenCalled();
    ctx.state.dialogForm = { authPassword: 'long enough password', authPasswordConfirm: 'long enough password' };
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(completeRecovery).toHaveBeenCalledWith('', 'long enough password');
    expect(ctx.state.dialogForm).toEqual({});
    expect(ctx.live.error?.code).toBe('expired');
  });

  it('accepts an invitation and fences duplicate submissions', async () => {
    const ctx = context();
    ctx.state.route = { screen: 'accept-invitation', conversationId: null, params: { token: 'i'.repeat(43) } };
    const acceptInvitation = vi.fn().mockResolvedValue({ ok: true, data: { tenant_id: 't', membership_id: 'm' } });
    Object.defineProperty(ctx.live, 'api', { value: { acceptInvitation } });
    ctx.state.dialogForm = { authPassword: 'long enough password', authPasswordConfirm: 'long enough password' };
    await expect(LIVE_ACTIONS['live-accept-invitation']?.(ctx, '')).resolves.toBe(true);
    expect(ctx.state.authFlowComplete).toBe('invitation');
    ctx.live.busy = 'already-busy';
    await expect(LIVE_ACTIONS['live-accept-invitation']?.(ctx, '')).resolves.toBe(false);
  });
});
