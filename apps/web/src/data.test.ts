import { describe, expect, it } from 'vitest';
import {
  buildDataset,
  CURRENT_MEMBER_ID,
  INBOXES,
  LABELS,
  MEMBERS,
  PERMISSION_KEYS,
  TEAMS,
  VIEWS,
} from './data';

const NOW = new Date('2026-09-08T12:00:00.000Z');

describe('buildDataset', () => {
  const dataset = buildDataset(NOW);

  it('derives every timestamp from the supplied now', () => {
    const later = buildDataset(new Date(NOW.getTime() + 60_000));
    expect(dataset.conversations[0]?.lastActivityAt).not.toBe(later.conversations[0]?.lastActivityAt);
    expect(dataset.now).toBe(NOW);
  });

  it('exposes the static reference data', () => {
    expect(dataset.teams).toBe(TEAMS);
    expect(dataset.inboxes).toBe(INBOXES);
    expect(dataset.members).toBe(MEMBERS);
    expect(dataset.labels).toBe(LABELS);
    expect(dataset.views).toBe(VIEWS);
    expect(PERMISSION_KEYS).toContain('conversation.unassigned.preview');
  });

  it('links every conversation to a real inbox, team and contact', () => {
    for (const conversation of dataset.conversations) {
      const inbox = dataset.inboxes.find((entry) => entry.id === conversation.inboxId);
      expect(inbox).toBeDefined();
      expect(conversation.teamId).toBe(inbox?.teamId);
      expect(conversation.channel).toBe(inbox?.channel);
      expect(dataset.contacts.some((entry) => entry.id === conversation.contactId)).toBe(true);
    }
  });

  it('gives every conversation a timeline', () => {
    for (const conversation of dataset.conversations) {
      expect(dataset.timelines[conversation.id]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('includes an expired channel window and a resolved thread with none', () => {
    const expired = dataset.conversations.find((entry) => entry.id === 'cv-4809');
    expect(new Date(expired?.windowExpiresAt ?? '').getTime()).toBeLessThan(NOW.getTime());
    const resolved = dataset.conversations.find((entry) => entry.id === 'cv-4808');
    expect(resolved?.windowExpiresAt).toBeNull();
  });

  it('includes a snoozed conversation with a future wake time', () => {
    const snoozed = dataset.conversations.find((entry) => entry.status === 'snoozed');
    expect(new Date(snoozed?.snoozedUntil ?? '').getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('gives the signed-in member every inbox so the demo shows the full workspace', () => {
    const me = dataset.members.find((entry) => entry.id === CURRENT_MEMBER_ID);
    expect(me?.inboxIds).toHaveLength(dataset.inboxes.length);
  });

  it('carries a suppressed contact and an unlinked contact', () => {
    expect(dataset.contacts.some((entry) => entry.suppression.active)).toBe(true);
    expect(dataset.contacts.some((entry) => entry.crm === null)).toBe(true);
    expect(dataset.contacts.some((entry) => entry.history.length === 0)).toBe(true);
  });

  it('models channels across every readiness state we render', () => {
    const readiness = dataset.channels.map((entry) => entry.readiness);
    expect(readiness).toContain('connected');
    expect(readiness).toContain('degraded');
    expect(readiness).toContain('reauthorization_required');
    expect(readiness).toContain('not_configured');
  });

  it('models campaigns with an unapproved one and an unknown-outcome ledger', () => {
    expect(dataset.campaigns.some((entry) => !entry.approved)).toBe(true);
    expect(dataset.campaigns.some((entry) => entry.ledger.unknown > 0)).toBe(true);
    expect(dataset.campaigns.some((entry) => entry.snapshotAt === null)).toBe(true);
  });
});
