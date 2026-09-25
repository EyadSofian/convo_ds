/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { MotionMemory } from './motion';
import { applyMotion, MOTION_WINDOW_MS, motionElapsed, motionKeys } from './motion';
import { createState } from './state';

const NOW = new Date('2026-09-26T09:00:00.000Z');

describe('motionElapsed', () => {
  it('starts a channel at zero, counts up inside the window and settles after it', () => {
    const memory: MotionMemory = new Map();
    expect(motionElapsed(memory, 'view', 'contacts|', 1000)).toBe(0);
    expect(motionElapsed(memory, 'view', 'contacts|', 1240)).toBe(240);
    expect(motionElapsed(memory, 'view', 'contacts|', 1000 + MOTION_WINDOW_MS)).toBeNull();
  });

  it('restarts the window when the key changes, independently per channel', () => {
    const memory: MotionMemory = new Map();
    motionElapsed(memory, 'view', 'inbox|', 0);
    motionElapsed(memory, 'detail', 'inbox|c-1', 0);
    expect(motionElapsed(memory, 'view', 'contacts|', 5000)).toBe(0);
    expect(motionElapsed(memory, 'detail', 'inbox|c-1', 5000)).toBeNull();
  });

  it('never publishes a negative offset when the clock steps backwards', () => {
    const memory: MotionMemory = new Map();
    motionElapsed(memory, 'view', 'inbox|', 2000);
    expect(motionElapsed(memory, 'view', 'inbox|', 1500)).toBe(0);
  });
});

describe('applyMotion', () => {
  it('stamps the phase and offset on the root, then settles it', () => {
    const root = document.createElement('div');
    const memory: MotionMemory = new Map();
    applyMotion(root, memory, 'view', 'contacts|', 100);
    expect(root.getAttribute('data-view')).toBe('enter');
    expect(root.style.getPropertyValue('--view-elapsed')).toBe('0ms');
    applyMotion(root, memory, 'view', 'contacts|', 400);
    expect(root.getAttribute('data-view')).toBe('enter');
    expect(root.style.getPropertyValue('--view-elapsed')).toBe('300ms');
    applyMotion(root, memory, 'view', 'contacts|', 100 + MOTION_WINDOW_MS);
    expect(root.getAttribute('data-view')).toBe('settled');
    expect(root.style.getPropertyValue('--view-elapsed')).toBe('0ms');
  });
});

describe('motionKeys', () => {
  it('keys the tool on the one open over the screen', () => {
    const state = createState(NOW);
    state.route = { screen: 'contacts', conversationId: null, params: {} };
    expect(motionKeys(state).tool).toBe('contacts|');
    state.dialogForm = { contactsTool: 'import' };
    expect(motionKeys(state).tool).toBe('contacts|import');
  });

  it('keys the view on the screen and its tab', () => {
    const state = createState(NOW);
    state.route = { screen: 'people', conversationId: null, params: { tab: 'invitations' } };
    expect(motionKeys(state).view).toBe('people|invitations');
    state.route = { screen: 'people', conversationId: null, params: {} };
    expect(motionKeys(state).view).toBe('people|');
  });

  it('keys the detail on the contact selected in the directory', () => {
    const state = createState(NOW);
    state.route = { screen: 'contacts', conversationId: null, params: {} };
    expect(motionKeys(state).detail).toBe('contacts|');
    state.live.selectedContactId = 'ct-1';
    expect(motionKeys(state).detail).toBe('contacts|ct-1');
  });

  it('keys the detail on the open conversation, role or team elsewhere', () => {
    const state = createState(NOW);
    state.live.selectedContactId = 'ct-1';
    state.route = { screen: 'inbox', conversationId: 'cv-1', params: {} };
    expect(motionKeys(state).detail).toBe('inbox|cv-1');
    state.route = { screen: 'roles', conversationId: null, params: { role: 'r-1' } };
    expect(motionKeys(state).detail).toBe('roles|r-1');
    state.route = { screen: 'teams', conversationId: null, params: { team: 't-1' } };
    expect(motionKeys(state).detail).toBe('teams|t-1');
    state.route = { screen: 'settings', conversationId: null, params: {} };
    expect(motionKeys(state).detail).toBe('settings|');
  });
});
