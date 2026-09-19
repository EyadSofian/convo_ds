const TASK_STATUSES = new Set(['completed', 'in_progress', 'upcoming', 'blocked']);
const REQUIREMENT_STATUSES = new Set(['pending', 'received', 'verified']);

export function tasksOf(days) {
  return days.flatMap((day) => day.tasks.map((task) => ({ ...task, day: day.day })));
}

export function validatePlan(days, currentDay, categories, deliverables) {
  if (!Number.isInteger(currentDay) || currentDay < 1 || currentDay > 12) throw new Error('CURRENT_PROJECT_DAY must be 1–12');
  if (days.length !== 12 || days.some((day, index) => day.day !== index + 1)) throw new Error('The plan must contain Days 1–12 in order');

  const tasks = tasksOf(days);
  const ids = new Set();
  for (const task of tasks) {
    if (!task.id || ids.has(task.id)) throw new Error(`Missing or repeated task ID: ${task.id}`);
    if (!TASK_STATUSES.has(task.status)) throw new Error(`Unknown task status: ${task.status}`);
    if (!(task.category in categories)) throw new Error(`Unknown category: ${task.category}`);
    if (!task.title || !task.clientDescription) throw new Error(`Missing client copy: ${task.id}`);
    if (task.clientActionRequired && task.status !== 'blocked') throw new Error(`Client action must belong to a blocked task: ${task.id}`);
    ids.add(task.id);
  }
  for (const deliverable of deliverables) {
    if (!deliverable.title || !deliverable.taskIds.length || deliverable.taskIds.some((id) => !ids.has(id))) {
      throw new Error(`Deliverable references an unknown task: ${deliverable.title}`);
    }
  }
  return true;
}

export function summarize(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  return {
    total,
    completed,
    inProgress,
    blocked,
    remaining: total - completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

export function statusOfDay(day) {
  if (day.tasks.every((task) => task.status === 'completed')) return 'completed';
  if (day.tasks.some((task) => task.status === 'in_progress')) return 'in_progress';
  if (day.tasks.some((task) => task.status === 'blocked')) return 'blocked';
  return 'upcoming';
}

export function categorySummaries(tasks, categories) {
  return Object.entries(categories).map(([key, label]) => ({
    key,
    label,
    ...summarize(tasks.filter((task) => task.category === key)),
  }));
}

export function clientActions(tasks) {
  return [...new Set(tasks.filter((task) => task.status === 'blocked' && task.clientActionRequired).map((task) => task.clientActionRequired))];
}

export function deliverableStatus(deliverable, tasks) {
  const selected = deliverable.taskIds.map((id) => tasks.find((task) => task.id === id));
  if (selected.every((task) => task.status === 'completed')) return 'completed';
  if (selected.some((task) => task.status === 'blocked')) return 'blocked';
  if (selected.some((task) => task.status === 'in_progress')) return 'in_progress';
  return 'upcoming';
}

export function validatePhases(phases, tasks, requirements) {
  if (phases.length !== 3 || phases.some((phase, index) => phase.number !== index + 1)) throw new Error('The plan must contain three ordered phases');
  const taskIds = new Set(tasks.map((task) => task.id));
  const dayCounts = new Map();
  for (const phase of phases) {
    if (!phase.title || !phase.description || phase.featuredTaskIds.length < 4 || phase.featuredTaskIds.length > 6) throw new Error(`Invalid phase presentation: ${phase.number}`);
    for (const day of phase.days) dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    if (phase.featuredTaskIds.some((id) => !taskIds.has(id) || !tasks.some((task) => task.id === id && phase.days.includes(task.day)))) throw new Error(`Phase ${phase.number} references a task outside its scope`);
  }
  const sourceDays = new Set(tasks.map((task) => task.day));
  if (dayCounts.size !== sourceDays.size || [...sourceDays].some((day) => dayCounts.get(day) !== 1)) throw new Error('Every source task stage must belong to exactly one phase');
  for (const requirement of requirements) {
    if (!requirement.title || !REQUIREMENT_STATUSES.has(requirement.status) || !taskIds.has(requirement.taskId)) throw new Error(`Invalid client requirement: ${requirement.id}`);
  }
  return true;
}

export function phaseTasks(phase, tasks) {
  return tasks.filter((task) => phase.days.includes(task.day));
}

export function statusOfPhase(tasks) {
  if (tasks.every((task) => task.status === 'completed')) return 'completed';
  if (tasks.some((task) => task.status === 'in_progress')) return 'in_progress';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  return 'upcoming';
}

export function currentPhase(phases, tasks) {
  return phases.find((phase) => phaseTasks(phase, tasks).some((task) => task.status !== 'completed')) || phases.at(-1);
}
