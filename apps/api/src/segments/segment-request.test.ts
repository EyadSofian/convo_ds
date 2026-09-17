import { describe, expect, it } from 'vitest';
import { parseAudience, parseSavedView, parseVersion, parseVersioned } from './segment-request.js';

const conditions = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'channel', operator: 'eq', value: 'whatsapp' }] } };

describe('segment requests', () => {
  it('parses private and team saved views in their resource context', () => {
    expect(parseSavedView({ name: ' My queue ', resource: 'conversations', visibility: 'private', conditions })).toMatchObject({ name: 'My queue', teamId: null });
    expect(parseSavedView({ name: 'Leads', resource: 'contacts', visibility: 'team', teamId: '11111111-1111-4111-8111-111111111111', conditions })).toMatchObject({ visibility: 'team' });
  });

  it.each([
    {},
    { name: 'x', resource: 'unknown', visibility: 'private', conditions },
    { name: 'x', resource: 'contacts', visibility: 'unknown', conditions },
    { name: 'x', resource: 'contacts', visibility: 'team', conditions },
    { name: 'x', resource: 'contacts', visibility: 'private', teamId: '11111111-1111-4111-8111-111111111111', conditions },
    { name: 'x', resource: 'contacts', visibility: 'private', conditions: { version: 9 } },
  ])('rejects an invalid saved view %#', (value) => {
    expect(() => parseSavedView(value)).toThrowError(/segment definition/i);
  });

  it('parses a reusable audience and its optional description', () => {
    expect(parseAudience({ name: ' Fall intake ', description: ' Interested students ', conditions })).toMatchObject({ name: 'Fall intake', description: 'Interested students' });
    expect(parseAudience({ name: 'All leads', conditions })).toMatchObject({ description: null });
  });

  it.each([
    { name: '', conditions },
    { name: 'A', description: 3, conditions },
    { name: 'A', conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [] } } },
  ])('rejects an invalid audience %#', (value) => {
    expect(() => parseAudience(value)).toThrowError(/segment definition/i);
  });

  it('requires positive safe versions for updates and retirement', () => {
    expect(parseVersion({ version: 2 })).toBe(2);
    expect(parseVersioned({ version: 3, name: 'A', conditions }, parseAudience)).toMatchObject({ version: 3, value: { name: 'A' } });
    for (const value of [{}, { version: 0 }, { version: 1.2 }, { version: Number.MAX_VALUE }]) {
      expect(() => parseVersion(value)).toThrowError(/segment definition/i);
    }
    expect(() => parseVersioned({ version: 0 }, parseAudience)).toThrowError(/segment definition/i);
    expect(() => parseVersion(null)).toThrowError(/segment definition/i);
    expect(() => parseVersion([])).toThrowError(/segment definition/i);
  });
});
