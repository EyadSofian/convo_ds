import { describe, expect, it } from 'vitest';
import { nextScheduledAt, validateScheduleDefinition } from './schedule.js';

describe('automation schedules',()=>{
 it('validates every schedule family and its bounds',()=>{
  expect(validateScheduleDefinition({kind:'one_time',at:'2026-09-20T10:00:00Z'})).toEqual([]);
  expect(validateScheduleDefinition({kind:'daily',time:'09:30'})).toEqual([]);
  expect(validateScheduleDefinition({kind:'weekly',time:'09:30',daysOfWeek:[1,3]})).toEqual([]);
  expect(validateScheduleDefinition({kind:'monthly',time:'09:30',dayOfMonth:15})).toEqual([]);
  expect(validateScheduleDefinition({kind:'custom_recurrence',everyMinutes:30})).toEqual([]);
  expect(validateScheduleDefinition({kind:'relative',offsetMinutes:-120})).toEqual([]);
  expect(validateScheduleDefinition({kind:'bad'})).toHaveLength(1);
  expect(validateScheduleDefinition({kind:'weekly',time:'25:00',daysOfWeek:[]})).toHaveLength(2);
  expect(validateScheduleDefinition({kind:'monthly',time:'09:00',dayOfMonth:32,startAt:'bad'})).toHaveLength(2);
  expect(validateScheduleDefinition({kind:'custom_recurrence',everyMinutes:0,endAt:'2026-01-01T00:00:00Z',startAt:'2026-02-01T00:00:00Z'})).toHaveLength(2);
  expect(validateScheduleDefinition({kind:'relative',offsetMinutes:900000})).toHaveLength(1);
  // A one-time schedule with no instant at all: the kind matches, the value is
  // missing, and only the second half of the guard can catch it.
  expect(validateScheduleDefinition({kind:'one_time'})).toHaveLength(1);
  expect(validateScheduleDefinition({kind:'weekly',daysOfWeek:[5]})).toHaveLength(1);
 });
 it('finds one-time, interval and timezone-aware calendar instants',()=>{
  const after=new Date('2026-09-17T06:00:00Z');
  expect(nextScheduledAt({kind:'one_time',at:'2026-09-17T07:00:00Z'},after,'UTC')?.toISOString()).toBe('2026-09-17T07:00:00.000Z');
  expect(nextScheduledAt({kind:'one_time',at:'2026-09-17T05:00:00Z'},after,'UTC')).toBeNull();
  expect(nextScheduledAt({kind:'custom_recurrence',everyMinutes:30,startAt:'2026-09-17T05:00:00Z'},after,'UTC')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
  expect(nextScheduledAt({kind:'daily',time:'10:00'},after,'Africa/Cairo')?.toISOString()).toBe('2026-09-17T07:00:00.000Z');
  expect(nextScheduledAt({kind:'weekly',time:'09:00',daysOfWeek:[5]},after,'UTC')?.toISOString()).toBe('2026-09-18T09:00:00.000Z');
  expect(nextScheduledAt({kind:'monthly',time:'09:00',dayOfMonth:20},after,'UTC')?.toISOString()).toBe('2026-09-20T09:00:00.000Z');
  expect(nextScheduledAt({kind:'relative',offsetMinutes:-60},after,'UTC')).toBeNull();
  expect(nextScheduledAt({kind:'daily'},after,'UTC')).toBeNull();
  expect(nextScheduledAt({kind:'custom_recurrence'},after,'UTC')).toBeNull();
  // One-time with no instant, and an interval with no anchor: the first has
  // nothing to schedule, the second anchors on "one period from now".
  expect(nextScheduledAt({kind:'one_time'},after,'UTC')).toBeNull();
  expect(nextScheduledAt({kind:'custom_recurrence',everyMinutes:30},after,'UTC')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
  // A calendar kind with no clock time cannot resolve to an instant.
  expect(nextScheduledAt({kind:'weekly',daysOfWeek:[5]},after,'UTC')).toBeNull();
 });
 it('honours start and end bounds',()=>{const after=new Date('2026-09-17T06:00:00Z');expect(nextScheduledAt({kind:'daily',time:'09:00',startAt:'2026-09-20T00:00:00Z'},after,'UTC')?.toISOString()).toBe('2026-09-20T09:00:00.000Z');expect(nextScheduledAt({kind:'daily',time:'09:00',endAt:'2026-09-17T08:00:00Z'},after,'UTC')).toBeNull();
 // A weekly schedule whose start is weeks away: the day matches long before
 // the start does, so the loop has to keep walking past candidates it found.
 expect(nextScheduledAt({kind:'weekly',time:'09:00',daysOfWeek:[5],startAt:'2026-10-05T00:00:00Z'},after,'UTC')?.toISOString()).toBe('2026-10-09T09:00:00.000Z');
 // A schedule no day can ever satisfy. The walk is bounded at 370 days and
 // then gives up, rather than looping forever looking for a day that is not
 // in the calendar.
 expect(nextScheduledAt({kind:'weekly',time:'09:00'},after,'UTC')).toBeNull();
 expect(nextScheduledAt({kind:'weekly',time:'09:00',daysOfWeek:[]},after,'UTC')).toBeNull();
 expect(nextScheduledAt({kind:'monthly',time:'09:00',dayOfMonth:0},after,'UTC')).toBeNull();});
});
