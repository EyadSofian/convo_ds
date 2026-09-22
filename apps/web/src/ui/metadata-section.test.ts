/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { ready } from '../live/store.js';
import { createState } from '../state.js';
import { metadataSection } from './metadata-section.js';

describe('typed metadata inputs', () => {
  it('uses browser-native email and telephone controls for the matching business types', () => {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.live.labels = ready([], 0);
    state.live.customFields = ready([
      { id: '11111111-1111-4111-8111-111111111111', target: 'contact', key: 'email', name: 'Email', type: 'email', options: [], state: 'active', version: 1 },
      { id: '22222222-2222-4222-8222-222222222222', target: 'contact', key: 'phone', name: 'Phone', type: 'phone', options: [], state: 'active', version: 1 },
    ], 0);
    const root = metadataSection(state, state.live, 'contact', { id: 'contact-1', labels: [], customFields: [] });
    expect(root.querySelector('input[type="email"]')).not.toBeNull();
    expect(root.querySelector('input[type="tel"]')).not.toBeNull();
  });

  it('keeps historical labels visible but removes every metadata mutation in a read-only lens', () => {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.live.labels = ready([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Very light', color: '#FFFDE7', state: 'active', version: 1 },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Very dark', color: '#050505', state: 'retired', version: 1 },
    ], 0);
    const root = metadataSection(state, state.live, 'conversation', {
      id: 'conversation-1',
      labels: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Very light', color: '#FFFDE7', state: 'active', version: 1 },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Very dark', color: '#050505', state: 'retired', version: 1 },
      ],
      customFields: [],
    }, { readOnly: true });
    expect(root.textContent).toContain('Very light');
    expect(root.textContent).toContain('Very dark');
    expect(root.querySelector('[data-act="live-metadata-label"]')).toBeNull();
    expect(root.querySelector('[data-act="live-metadata-field"]')).toBeNull();
    expect(root.querySelectorAll('.metadata__swatch')).toHaveLength(2);
  });
});
