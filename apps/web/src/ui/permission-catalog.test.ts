import { describe, expect, it } from 'vitest';
import { groupPermissions, PERMISSION_GROUPS, PERMISSION_LABELS } from './permission-catalog.js';

describe('the permission catalogue', () => {
  it('groups only the keys the server listed, in module order, with no empty modules', () => {
    const groups = groupPermissions(['report.read', 'conversation.read']);
    expect(groups.map((group) => group.id)).toEqual(['conversations', 'reporting']);
    expect(groups.flatMap((group) => group.keys)).toEqual(['conversation.read', 'report.read']);
  });

  it('puts a key this build does not know under Other, never dropping it', () => {
    const groups = groupPermissions(['conversation.read', 'future.thing']);
    expect(groups.at(-1)).toMatchObject({ id: 'other', keys: ['future.thing'] });
  });

  it('labels every key it groups, in both languages', () => {
    for (const key of PERMISSION_GROUPS.flatMap((group) => group.keys)) {
      expect(PERMISSION_LABELS[key]?.ar, key).toBeTruthy();
      expect(PERMISSION_LABELS[key]?.en, key).toBeTruthy();
    }
  });
});
