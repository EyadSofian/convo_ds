import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_LABELS, CURRENT_PROJECT_DAY, DELIVERABLES, PROJECT_DAYS } from './progress-data.js';
import { categorySummaries, clientActions, deliverableStatus, statusOfDay, summarize, tasksOf, validatePlan } from './progress-model.js';

const tasks = tasksOf(PROJECT_DAYS);

test('the public plan has twelve ordered days and one central current day', () => {
  assert.equal(validatePlan(PROJECT_DAYS, CURRENT_PROJECT_DAY, CATEGORY_LABELS, DELIVERABLES), true);
  assert.equal(CURRENT_PROJECT_DAY, 2);
  assert.equal(tasks.length, 36);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.equal(statusOfDay(PROJECT_DAYS[0]), 'completed');
  assert.equal(statusOfDay(PROJECT_DAYS[1]), 'in_progress');
});

test('all numbers derive from the status data and count blocked work as remaining', () => {
  assert.deepEqual(summarize(tasks), { total: 36, completed: 16, inProgress: 3, blocked: 10, remaining: 20, percent: 44 });
  const areas = categorySummaries(tasks, CATEGORY_LABELS);
  assert.equal(areas.length, 8);
  assert.equal(areas.reduce((sum, area) => sum + area.total, 0), tasks.length);
  assert.equal(areas.reduce((sum, area) => sum + area.completed, 0), 16);
});

test('client actions and deliverables are derived rather than hand-entered in the page', () => {
  assert.equal(clientActions(tasks).length, 5);
  assert.equal(deliverableStatus(DELIVERABLES[0], tasks), 'in_progress');
  assert.equal(deliverableStatus(DELIVERABLES[2], tasks), 'blocked');
});

test('public task data has no technical or secret identifiers', () => {
  const copy = JSON.stringify({ days: PROJECT_DAYS, deliverables: DELIVERABLES });
  assert.doesNotMatch(copy, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  assert.doesNotMatch(copy, /\b[0-9a-f]{40}\b/i);
  assert.doesNotMatch(copy, /(?:sk_|re_|whsec_|Bearer\s|Postgres|Railway|migration|incident|vulnerability|RLS|Git SHA)/i);
  assert.doesNotMatch(copy, /\b20\d\d-\d\d-\d\d\b/);
});

test('invalid days, IDs, statuses and references cannot silently skew progress', () => {
  assert.throws(() => validatePlan(PROJECT_DAYS, 13, CATEGORY_LABELS, DELIVERABLES));
  assert.throws(() => validatePlan(PROJECT_DAYS.slice(1), 2, CATEGORY_LABELS, DELIVERABLES));
  assert.throws(() => validatePlan(PROJECT_DAYS, 2, CATEGORY_LABELS, [{ title: 'Bad', taskIds: ['missing'] }]));
});
