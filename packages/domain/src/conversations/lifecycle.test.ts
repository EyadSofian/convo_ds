import { describe, expect, it } from 'vitest';
import {
  applyTrigger,
  checkSnooze,
  CONVERSATION_STATES,
  isConversationState,
  LIFECYCLE_TRIGGERS,
  occupiesIdentity,
} from './lifecycle.js';
import type { ConversationState, LifecycleTrigger } from './lifecycle.js';

/**
 * The lifecycle table, one test per row of MASTER-PROMPT §18.1.
 *
 * The rows that say *nothing changes* are tested as carefully as the rows that
 * move the state, because those are the ones a later refactor silently breaks:
 * nobody writes a test called "a receipt does not reopen a resolved
 * conversation" after the fact, and by then the reports are already wrong.
 */

const NOW = new Date('2026-09-10T09:00:00.000Z');

describe('§18.1 row by row', () => {
  it('customer inbound on an open conversation keeps it open and moves the cursor', () => {
    const outcome = applyTrigger('open', 'customer_inbound');
    expect(outcome.to).toBe('open');
    expect(outcome.changed).toBe(false);
    expect(outcome.effects).toContain('record_activity');
    expect(outcome.effects).toContain('start_response_clock');
  });

  it('an agent explicitly waiting moves open to pending and records why', () => {
    const outcome = applyTrigger('open', 'agent_waits');
    expect(outcome.to).toBe('pending');
    expect(outcome.changed).toBe(true);
    expect(outcome.effects).toEqual(['record_waiting_reason']);
  });

  it('customer inbound on a pending conversation reopens it and clears the reason', () => {
    const outcome = applyTrigger('pending', 'customer_inbound');
    expect(outcome.to).toBe('open');
    expect(outcome.effects).toContain('clear_waiting_reason');
  });

  it('an agent snoozing schedules a wake', () => {
    expect(applyTrigger('open', 'agent_snoozes')).toMatchObject({
      to: 'snoozed',
      changed: true,
      effects: ['schedule_wake'],
    });
    // From pending, the waiting reason goes too: the conversation is now
    // deferred, not waiting on somebody.
    expect(applyTrigger('pending', 'agent_snoozes').effects).toContain('clear_waiting_reason');
  });

  it('re-snoozing invalidates the wake already scheduled before scheduling another', () => {
    const outcome = applyTrigger('snoozed', 'agent_snoozes');
    expect(outcome.to).toBe('snoozed');
    // Order matters: the old job must be dead before a new one exists, or the
    // first fires at the original time and wakes the conversation early.
    expect(outcome.effects).toEqual(['invalidate_wake', 'schedule_wake']);
  });

  it('the wake time opens a snoozed conversation and notifies the team once', () => {
    const outcome = applyTrigger('snoozed', 'wake_due');
    expect(outcome.to).toBe('open');
    expect(outcome.effects).toEqual(['invalidate_wake', 'notify_team']);
  });

  it('a customer message also ends a snooze, and notifies once rather than twice', () => {
    const outcome = applyTrigger('snoozed', 'customer_inbound');
    expect(outcome.to).toBe('open');
    expect(outcome.effects).toContain('invalidate_wake');
    expect(outcome.effects.filter((effect) => effect === 'notify_team')).toHaveLength(1);
  });

  it('resolving records the resolution and cancels timers', () => {
    for (const from of ['open', 'pending', 'snoozed'] as const) {
      const outcome = applyTrigger(from, 'agent_resolves');
      expect(outcome.to).toBe('resolved');
      expect(outcome.effects).toContain('record_resolution');
      expect(outcome.effects).toContain('cancel_timers');
    }
    // A snooze being resolved must kill its wake job, or the conversation
    // reopens itself hours later with nobody expecting it.
    expect(applyTrigger('snoozed', 'agent_resolves').effects).toContain('invalidate_wake');
  });

  it('resolving does not pretend an unread customer message was read', () => {
    const effects = applyTrigger('open', 'agent_resolves').effects;
    // There is no read effect in the vocabulary at all, and there must not be:
    // closing an issue is not the same act as somebody reading it.
    expect(effects).not.toContain('record_activity');
    expect(effects.some((effect) => effect.includes('read'))).toBe(false);
  });

  it('a new inbound on a resolved thread reopens it and starts a new reporting episode', () => {
    const outcome = applyTrigger('resolved', 'customer_inbound');
    expect(outcome.to).toBe('open');
    expect(outcome.changed).toBe(true);
    // Retaining the first episode's metrics is the whole point: reusing it
    // would date the second issue's clock from the first issue's first message.
    expect(outcome.effects).toContain('start_new_episode');
    expect(outcome.startsNewThread).toBe(false);
  });

  it('an agent reopening is the same transition, so it is the same new episode', () => {
    expect(applyTrigger('resolved', 'agent_reopens')).toMatchObject({
      to: 'open',
      effects: ['start_new_episode'],
    });
  });

  it('a new inbound after archival starts a new thread and never mutates the archived one', () => {
    const outcome = applyTrigger('archived', 'customer_inbound');
    expect(outcome.startsNewThread).toBe(true);
    expect(outcome.to).toBe('archived');
    expect(outcome.changed).toBe(false);
    expect(outcome.effects).toEqual([]);
  });

  it('a receipt, a duplicate or a private note changes nothing from any state', () => {
    for (const state of CONVERSATION_STATES) {
      const outcome = applyTrigger(state, 'internal_activity');
      expect(outcome).toEqual({
        from: state,
        to: state,
        changed: false,
        effects: [],
        refusal: null,
        startsNewThread: false,
      });
    }
  });
});

describe('what the table refuses', () => {
  it('refuses every trigger on an archived conversation except a new inbound', () => {
    for (const trigger of LIFECYCLE_TRIGGERS) {
      const outcome = applyTrigger('archived', trigger);
      if (trigger === 'customer_inbound') {
        expect(outcome.startsNewThread).toBe(true);
        continue;
      }
      if (trigger === 'internal_activity') {
        expect(outcome.refusal).toBeNull();
        continue;
      }
      expect(outcome.refusal).toBe('archived_conversation_is_immutable');
      expect(outcome.to).toBe('archived');
    }
  });

  it('refuses to wait on a customer that is not being waited on', () => {
    expect(applyTrigger('pending', 'agent_waits').refusal).toBe('not_waiting_on_a_customer');
    expect(applyTrigger('resolved', 'agent_waits').refusal).toBe('not_waiting_on_a_customer');
    expect(applyTrigger('snoozed', 'agent_waits').refusal).toBe('not_waiting_on_a_customer');
  });

  it('refuses a wake for a conversation nobody snoozed', () => {
    for (const from of ['open', 'pending', 'resolved'] as const) {
      expect(applyTrigger(from, 'wake_due').refusal).toBe('wake_without_snooze');
    }
  });

  it('refuses to reopen what is already open', () => {
    for (const from of ['open', 'pending', 'snoozed'] as const) {
      expect(applyTrigger(from, 'agent_reopens').refusal).toBe('already_open');
    }
  });

  it('refuses to archive live work', () => {
    for (const from of ['open', 'pending', 'snoozed'] as const) {
      expect(applyTrigger(from, 'agent_archives').refusal).toBe('not_resolved');
    }
    expect(applyTrigger('resolved', 'agent_archives')).toMatchObject({
      to: 'archived',
      effects: ['cancel_timers'],
    });
  });

  it('resolving something already resolved is accepted and does nothing', () => {
    // Two agents pressing Resolve is not an error worth showing anybody.
    expect(applyTrigger('resolved', 'agent_resolves')).toMatchObject({
      to: 'resolved',
      changed: false,
      effects: [],
      refusal: null,
    });
  });

  it('leaves the state alone whenever it refuses', () => {
    for (const state of CONVERSATION_STATES) {
      for (const trigger of LIFECYCLE_TRIGGERS) {
        const outcome = applyTrigger(state, trigger);
        if (outcome.refusal !== null) {
          expect(outcome.to).toBe(state);
          expect(outcome.changed).toBe(false);
          expect(outcome.effects).toEqual([]);
        }
      }
    }
  });

  it('answers for every state and trigger pair', () => {
    for (const state of CONVERSATION_STATES) {
      for (const trigger of LIFECYCLE_TRIGGERS) {
        const outcome = applyTrigger(state, trigger);
        expect(CONVERSATION_STATES).toContain(outcome.to);
        expect(outcome.from).toBe(state);
      }
    }
  });
});

describe('the states themselves', () => {
  it('recognises its own states and nothing else', () => {
    expect(isConversationState('open')).toBe(true);
    expect(isConversationState('archived')).toBe(true);
    expect(isConversationState('pending_review')).toBe(false);
    expect(isConversationState(7)).toBe(false);
    expect(isConversationState(null)).toBe(false);
  });

  it('holds the identity until the thread is archived', () => {
    // `resolved` still occupies it: a new inbound reopens that thread, so a
    // second row beside it would be a duplicate conversation with one customer.
    for (const state of ['open', 'pending', 'snoozed', 'resolved'] as const) {
      expect(occupiesIdentity(state)).toBe(true);
    }
    expect(occupiesIdentity('archived')).toBe(false);
  });
});

describe('a snooze', () => {
  it('accepts a future time in a known zone', () => {
    expect(
      checkSnooze({ wakeAt: new Date(NOW.getTime() + 3_600_000), timezone: 'Asia/Riyadh' }, NOW),
    ).toBeNull();
  });

  it('refuses a wake time that has already passed', () => {
    expect(checkSnooze({ wakeAt: NOW, timezone: 'Asia/Riyadh' }, NOW)).toBe('wake_time_in_the_past');
    expect(
      checkSnooze({ wakeAt: new Date(NOW.getTime() - 1000), timezone: 'UTC' }, NOW),
    ).toBe('wake_time_in_the_past');
  });

  it('refuses a wake time further out than a year', () => {
    const twoYears = new Date(NOW.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);
    // Usually a unit mistake — seconds read as milliseconds — and a conversation
    // that wakes in 2028 is a conversation nobody ever sees again.
    expect(checkSnooze({ wakeAt: twoYears, timezone: 'UTC' }, NOW)).toBe('wake_time_too_far_ahead');
  });

  it('refuses a timezone the runtime does not know', () => {
    // Caught here, in front of the person who chose it, rather than at wake
    // time inside a worker where nobody is looking.
    expect(
      checkSnooze({ wakeAt: new Date(NOW.getTime() + 3_600_000), timezone: 'Mars/Olympus' }, NOW),
    ).toBe('unknown_timezone');
    expect(
      checkSnooze({ wakeAt: new Date(NOW.getTime() + 3_600_000), timezone: '' }, NOW),
    ).toBe('unknown_timezone');
  });

  it('checks the zone before the clock', () => {
    // A request that is wrong in both ways names the zone: fixing the time
    // would not have helped.
    expect(checkSnooze({ wakeAt: new Date(NOW.getTime() - 1000), timezone: 'Nowhere' }, NOW)).toBe(
      'unknown_timezone',
    );
  });
});

describe('the vocabulary', () => {
  it('exposes states and triggers as closed lists', () => {
    const states: readonly ConversationState[] = CONVERSATION_STATES;
    const triggers: readonly LifecycleTrigger[] = LIFECYCLE_TRIGGERS;
    expect(new Set(states).size).toBe(states.length);
    expect(new Set(triggers).size).toBe(triggers.length);
  });
});
