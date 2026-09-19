import { CATEGORY_LABELS, CURRENT_PROJECT_DAY, DELIVERABLES, PROJECT_DAYS } from './progress-data.js';
import { categorySummaries, clientActions, deliverableStatus, statusOfDay, summarize, tasksOf, validatePlan } from './progress-model.js';

const STATUS_LABELS = {
  completed: 'Completed',
  in_progress: 'In progress',
  upcoming: 'Upcoming',
  blocked: 'Waiting for client',
};
const STATUS_MARKS = { completed: '✓', in_progress: '●', upcoming: '○', blocked: '!' };

function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function replace(id, ...children) {
  document.getElementById(id).replaceChildren(...children);
}

function statusBadge(status) {
  const badge = element('span', `status-badge status-badge--${status}`);
  badge.append(element('span', 'status-badge__mark', STATUS_MARKS[status]), element('span', '', STATUS_LABELS[status]));
  return badge;
}

function taskItem(task, compact = false, showStatus = false) {
  const item = element('li', compact ? 'task task--compact' : 'task');
  const mark = element('span', `task__mark task__mark--${task.status}`, STATUS_MARKS[task.status]);
  mark.setAttribute('aria-hidden', 'true');
  const copy = element('span', 'task__copy');
  copy.append(element('strong', '', task.title));
  if (showStatus) copy.append(element('span', 'task__status', STATUS_LABELS[task.status]));
  if (!compact) copy.append(element('span', 'task__description', task.clientDescription));
  item.append(mark, copy);
  return item;
}

function renderDayDetail(day) {
  const detail = element('div', 'day-detail__inner');
  const intro = element('div', 'day-detail__intro');
  intro.append(element('span', 'day-detail__number', `DAY ${String(day.day).padStart(2, '0')}`), element('h3', '', day.title), element('p', '', day.outcome));
  const groups = element('div', 'day-detail__groups');
  for (const [status, label] of [['completed', 'Completed'], ['in_progress', 'In progress'], ['upcoming', 'Next steps'], ['blocked', 'Waiting for client']]) {
    const tasks = day.tasks.filter((task) => task.status === status);
    if (!tasks.length) continue;
    const group = element('div', 'day-detail__group');
    group.append(element('h4', '', label));
    const list = element('ul', 'clean-list');
    list.append(...tasks.map((task) => taskItem(task)));
    group.append(list);
    groups.append(group);
  }
  detail.append(intro, groups);
  replace('day-detail', detail);
}

function renderTimeline() {
  let selected = CURRENT_PROJECT_DAY;
  const buttons = [];
  for (const day of PROJECT_DAYS) {
    const button = element('button', `day-card day-card--${statusOfDay(day)}`);
    button.type = 'button';
    button.setAttribute('aria-controls', 'day-detail');
    button.setAttribute('aria-expanded', String(day.day === selected));
    button.setAttribute('aria-label', `Day ${day.day}: ${day.title}, ${STATUS_LABELS[statusOfDay(day)]}`);
    button.append(element('span', 'day-card__index', `DAY ${String(day.day).padStart(2, '0')}`), statusBadge(statusOfDay(day)), element('strong', 'day-card__title', day.title), element('span', 'day-card__summary', day.summary));
    if (day.day === CURRENT_PROJECT_DAY) button.append(element('span', 'day-card__current', 'CURRENT STAGE'));
    button.addEventListener('click', () => {
      selected = day.day;
      for (const item of buttons) {
        item.classList.toggle('is-selected', Number(item.dataset.day) === selected);
        item.setAttribute('aria-expanded', String(Number(item.dataset.day) === selected));
      }
      renderDayDetail(day);
      if (window.matchMedia('(max-width: 760px)').matches) {
        document.getElementById('day-detail').scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    });
    button.dataset.day = String(day.day);
    button.classList.toggle('is-selected', day.day === selected);
    buttons.push(button);
  }
  replace('timeline', ...buttons);
  renderDayDetail(PROJECT_DAYS[CURRENT_PROJECT_DAY - 1]);
}

function renderCategories(tasks) {
  const cards = categorySummaries(tasks, CATEGORY_LABELS).map((category) => {
    const card = element('div', 'category');
    const top = element('div', 'category__top');
    top.append(element('strong', '', category.label), element('span', '', `${category.percent}%`));
    const meter = element('div', 'category__track');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', `${category.label} completion`);
    meter.setAttribute('aria-valuenow', String(category.percent));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    const fill = element('span');
    fill.style.width = `${category.percent}%`;
    meter.append(fill);
    card.append(top, meter, element('small', '', `${category.completed} of ${category.total} tasks complete`));
    return card;
  });
  replace('category-grid', ...cards);
}

function renderLists(tasks) {
  replace('completed-list', ...tasks.filter((task) => task.status === 'completed').map((task) => taskItem(task, true)));
  replace('working-list', ...tasks.filter((task) => task.status === 'in_progress').map((task) => taskItem(task)));
  const upcoming = tasks.filter((task) => task.day > CURRENT_PROJECT_DAY && (task.status === 'upcoming' || (task.status === 'blocked' && task.clientActionRequired))).slice(0, 4);
  replace('next-list', ...upcoming.map((task) => taskItem({ ...task, title: `Day ${task.day} · ${task.title}` }, false, true)));
  const actions = clientActions(tasks);
  document.getElementById('client-action-section').hidden = actions.length === 0;
  replace('client-action-list', ...actions.map((action) => element('li', '', action)));
}

function renderDeliverables(tasks) {
  const rows = DELIVERABLES.map((deliverable) => {
    const status = deliverableStatus(deliverable, tasks);
    const row = element('li', 'deliverable');
    row.append(element('span', `deliverable__mark deliverable__mark--${status}`, STATUS_MARKS[status]), element('span', '', deliverable.title), statusBadge(status));
    return row;
  });
  replace('deliverables-list', ...rows);
}

function init() {
  validatePlan(PROJECT_DAYS, CURRENT_PROJECT_DAY, CATEGORY_LABELS, DELIVERABLES);
  const tasks = tasksOf(PROJECT_DAYS);
  const progress = summarize(tasks);
  replace('current-stage', element('span', '', `DAY ${CURRENT_PROJECT_DAY} OF 12`), element('strong', '', PROJECT_DAYS[CURRENT_PROJECT_DAY - 1].title));
  replace('overall-percent', `${progress.percent}%`);
  document.getElementById('overall-fill').style.width = `${progress.percent}%`;
  replace('current-day-stat', String(CURRENT_PROJECT_DAY).padStart(2, '0'));
  replace('completed-stat', String(progress.completed).padStart(2, '0'));
  replace('active-stat', String(progress.inProgress).padStart(2, '0'));
  replace('remaining-stat', String(progress.remaining).padStart(2, '0'));
  renderTimeline();
  renderCategories(tasks);
  renderLists(tasks);
  renderDeliverables(tasks);
}

init();
