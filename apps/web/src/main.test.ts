/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

describe('main', () => {
  it('boots into #app on import, behind the authentication gate', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 401 })));
    try {
      document.body.replaceChildren();
      const root = document.createElement('div');
      root.id = 'app';
      document.body.appendChild(root);
      await import('./main');
      expect(root.querySelector('.gate')).not.toBeNull();
      // Nothing of the workspace exists before the server confirms a session.
      expect(root.querySelector('.nav, .inbox, .header')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
