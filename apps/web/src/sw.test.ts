import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type EventHandler = (event: Record<string, unknown>) => void;

function worker(windows: readonly Record<string, unknown>[] = []) {
  const handlers = new Map<string, EventHandler>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(windows);
  const self = {
    navigator: { language: 'en-US' }, location: { origin: 'https://convo.example' },
    addEventListener: (name: string, handler: EventHandler) => handlers.set(name, handler),
    clients: { matchAll, openWindow }, registration: { showNotification },
  };
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, { self, URL });
  async function dispatch(name: string, data: Record<string, unknown>) {
    let completion: Promise<unknown> | null = null;
    handlers.get(name)?.({ ...data, waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    await completion;
  }
  return { self, showNotification, openWindow, matchAll, dispatch };
}

const ID = '55555555-5555-4555-8555-555555555555';

describe('PWA push worker', () => {
  it('uses generic text and only an opaque, validated deep link', async () => {
    const { dispatch, showNotification } = worker();
    await dispatch('push', { data: { json: () => ({ kind: 'new_message', targetType: 'conversation', targetId: ID,
      id: ID, customerName: 'PRIVATE CUSTOMER', body: 'PRIVATE MESSAGE' }) } });
    expect(showNotification).toHaveBeenCalledWith('New customer message', expect.objectContaining({
      data: { url: `/#/inbox/${ID}` }, tag: ID,
    }));
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain('PRIVATE');
    await dispatch('push', { data: { json: () => ({ kind: 'campaign', targetType: 'campaign', targetId: 'https://evil.example' }) } });
    expect(showNotification.mock.lastCall?.[1]).toMatchObject({ data: { url: '/#/inbox' } });
  });

  it('suppresses duplicate OS hints when an app window is visible and tolerates bad payloads', async () => {
    const { dispatch, showNotification } = worker([{ visibilityState: 'visible' }]);
    await dispatch('push', { data: { json: () => { throw new Error('bad payload'); } } });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('focuses an existing app after a push tap, otherwise opens a safe app route', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = worker([{ url: 'https://convo.example/#/channels', navigate, focus }]);
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: `/#/inbox/${ID}` } } });
    expect(navigate).toHaveBeenCalledWith(`https://convo.example/#/inbox/${ID}`);
    expect(focus).toHaveBeenCalled();
    const fresh = worker();
    await fresh.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: 'https://evil.example/' } } });
    expect(fresh.openWindow).toHaveBeenCalledWith('https://convo.example/#/inbox');
  });
});
