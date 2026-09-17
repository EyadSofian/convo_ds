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
});
