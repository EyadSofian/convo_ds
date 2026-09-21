import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_LABELS, CLIENT_REQUIREMENTS, CURRENT_PROJECT_DAY, DELIVERABLES, PROJECT_DAYS, PROJECT_PHASES } from './progress-data.js';
import { categorySummaries, clientActions, currentPhase, deliverableStatus, phaseTasks, statusOfDay, statusOfPhase, summarize, tasksOf, validatePhases, validatePlan } from './progress-model.js';

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
  assert.deepEqual(summarize(tasks), { total: 36, completed: 19, inProgress: 2, blocked: 8, remaining: 17, percent: 53 });
  const areas = categorySummaries(tasks, CATEGORY_LABELS);
  assert.equal(areas.length, 8);
  assert.equal(areas.reduce((sum, area) => sum + area.total, 0), tasks.length);
  assert.equal(areas.reduce((sum, area) => sum + area.completed, 0), 19);
});

test('three presentation phases cover each task exactly once without changing completion', () => {
  assert.equal(validatePhases(PROJECT_PHASES, tasks, CLIENT_REQUIREMENTS), true);
  const grouped = PROJECT_PHASES.flatMap((phase) => phaseTasks(phase, tasks));
  assert.equal(grouped.length, tasks.length);
  assert.equal(new Set(grouped.map((task) => task.id)).size, tasks.length);
  assert.equal(summarize(grouped).percent, 53);
  assert.equal(currentPhase(PROJECT_PHASES, tasks).number, 1);
  assert.deepEqual(PROJECT_PHASES.map((phase) => statusOfPhase(phaseTasks(phase, tasks))), ['in_progress', 'in_progress', 'blocked']);
  assert.deepEqual(PROJECT_PHASES.map((phase) => summarize(phaseTasks(phase, tasks)).percent), [75, 58, 25]);
});

test('client access prerequisites stay pending until independently received and verified', () => {
  assert.equal(CLIENT_REQUIREMENTS.length, 4);
  assert.ok(CLIENT_REQUIREMENTS.every((item) => item.status === 'pending' && item.taskId === 'whatsapp-access'));
  assert.throws(() => validatePhases(PROJECT_PHASES, tasks, [{ ...CLIENT_REQUIREMENTS[0], status: 'connected' }]));
  assert.equal(validatePhases(PROJECT_PHASES, tasks, [{ ...CLIENT_REQUIREMENTS[0], status: 'received' }]), true);
  assert.throws(() => validatePhases([{ ...PROJECT_PHASES[0], days: [1, 2] }, ...PROJECT_PHASES.slice(1)], tasks, CLIENT_REQUIREMENTS));
});

test('client actions and deliverables are derived rather than hand-entered in the page', () => {
  assert.equal(clientActions(tasks).length, 4);
  assert.equal(deliverableStatus(DELIVERABLES[0], tasks), 'in_progress');
  assert.equal(deliverableStatus(DELIVERABLES[2], tasks), 'blocked');
});

test('public task data has no technical or secret identifiers', () => {
  const copy = JSON.stringify({ days: PROJECT_DAYS, phases: PROJECT_PHASES, requirements: CLIENT_REQUIREMENTS, deliverables: DELIVERABLES });
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
