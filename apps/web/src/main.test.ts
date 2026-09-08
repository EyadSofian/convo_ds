/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

describe('main', () => {
  it('boots the workspace into #app on import', async () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
    await import('./main');
    expect(root.querySelector('.shell')).not.toBeNull();
    expect(root.querySelector('.inbox')).not.toBeNull();
  });
});
