import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from './data';
import { buildDataset, CURRENT_MEMBER_ID } from './data';
import type { Actor } from './permissions';
import {
  contactNameFor,
  projectCard,
  projectThread,
  visibleConversations,
} from './projection';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const dataset = buildDataset(NOW);

const supervisor: Actor = {
  memberId: CURRENT_MEMBER_ID,
  name: 'هناء',
  nameEn: 'Hanaa',
  role: 'supervisor',
  inboxIds: ['ib-wa-cairo', 'ib-wa-orders', 'ib-ig', 'ib-mg'],
  teamIds: ['t-care'],
};
const agent: Actor = { ...supervisor, role: 'agent' };
const analyst: Actor = { ...supervisor, role: 'analyst' };

function record(id: string): ConversationRecord {
  const found = dataset.conversations.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture ${id} missing`);
  return found;
}

describe('projectCard', () => {
  it('returns a full card with a snippet for a permitted reader', () => {
    const card = projectCard(record('cv-4821'), supervisor, 'مريم خالد');
    expect(card?.access).toBe('full');
    if (card?.access !== 'full') throw new Error('expected full');
    expect(card.snippet.length).toBeGreaterThan(0);
    expect(card.contactName).toBe('مريم خالد');
  });

  it('returns a queue card with no snippet and no name for an agent', () => {
    const card = projectCard(record('cv-4817'), agent, 'أحمد بدر الدين');
    expect(card?.access).toBe('queue');
    if (card?.access !== 'queue') throw new Error('expected queue');
    expect(Object.keys(card)).not.toContain('snippet');
    expect(Object.keys(card)).not.toContain('contactName');
    expect(Object.keys(card)).not.toContain('labels');
    expect(JSON.stringify(card)).not.toContain('أحمد بدر الدين');
    expect(card.maskedLabel).toBe('أ••• ب•• ا•••');
    expect(Object.keys(card)).not.toContain('claimable');
  });

  it('returns null when the conversation is not disclosed at all', () => {
    expect(projectCard(record('cv-4821'), analyst, 'مريم')).toBeNull();
  });
});

describe('projectThread', () => {
  it('hands back timeline items only for full access', () => {
    const projected = projectThread(record('cv-4821'), supervisor, dataset);
    expect(projected.access).toBe('full');
    if (projected.access !== 'full') throw new Error('expected full');
    expect(projected.items.length).toBeGreaterThan(3);
  });

  it('refuses to hand back items for a queue card', () => {
    const projected = projectThread(record('cv-4817'), agent, dataset);
    expect(projected.access).toBe('queue');
    if (projected.access !== 'queue') throw new Error('expected queue');
    expect(projected.maskedLabel).not.toContain('أحمد');
    expect(Object.keys(projected)).not.toContain('items');
  });

  it('reports none for an undisclosed conversation', () => {
    expect(projectThread(record('cv-4821'), analyst, dataset).access).toBe('none');
  });

  it('returns an empty list when a conversation has no stored timeline', () => {
    const orphan: ConversationRecord = { ...record('cv-4821'), id: 'cv-none' };
    const projected = projectThread(orphan, supervisor, dataset);
    if (projected.access !== 'full') throw new Error('expected full');
    expect(projected.items).toEqual([]);
  });

  it('masks an unknown contact without throwing', () => {
    const orphan: ConversationRecord = { ...record('cv-4817'), contactId: 'ct-missing' };
    const projected = projectThread(orphan, agent, dataset);
    if (projected.access !== 'queue') throw new Error('expected queue');
    expect(projected.maskedLabel).toBe('••••');
  });
});

describe('visibleConversations and contactNameFor', () => {
  it('drops everything the actor may not see', () => {
    expect(visibleConversations(dataset, supervisor).length).toBe(dataset.conversations.length);
    expect(visibleConversations(dataset, analyst)).toHaveLength(0);
    expect(visibleConversations(dataset, agent).length).toBeLessThan(dataset.conversations.length);
  });

  it('resolves a contact name, or a dash when unknown', () => {
    expect(contactNameFor(dataset, 'ct-mariam')).toBe('مريم خالد عبد الجواد');
    expect(contactNameFor(dataset, 'ct-nope')).toBe('—');
  });
});
