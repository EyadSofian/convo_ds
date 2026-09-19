import { CATEGORY_LABELS, CLIENT_REQUIREMENTS, CURRENT_PROJECT_DAY, DELIVERABLES, PROJECT_DAYS, PROJECT_PHASES } from './progress-data.js';
import { currentPhase, deliverableStatus, phaseTasks, statusOfPhase, summarize, tasksOf, validatePhases, validatePlan } from './progress-model.js';

const STATUS_LABELS = {
  completed: 'Completed',
  in_progress: 'In Progress',
  upcoming: 'Upcoming',
  blocked: 'Waiting for Client',
};
const REQUIREMENT_LABELS = { pending: 'Pending', received: 'Received', verified: 'Verified' };

function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function replace(id, ...children) {
  document.getElementById(id).replaceChildren(...children);
}

function taskRow(task) {
  const row = element('li', 'phase-task');
  const marker = element('span', `phase-task__marker phase-task__marker--${task.status}`, task.status === 'completed' ? '✓' : '');
  marker.setAttribute('aria-hidden', 'true');
  row.append(marker, element('span', 'phase-task__name', task.title), element('span', `phase-task__state phase-task__state--${task.status}`, STATUS_LABELS[task.status]));
  return row;
}

function renderPhases(tasks, activePhase) {
  const cards = PROJECT_PHASES.map((phase) => {
    const selected = phaseTasks(phase, tasks);
    const summary = summarize(selected);
    const status = statusOfPhase(selected);
    const card = element('article', `phase-card phase-card--${status}${phase.number === activePhase.number ? ' phase-card--current' : ''}`);
    const header = element('div', 'phase-card__header');
    header.append(element('span', 'phase-card__number', `PHASE ${String(phase.number).padStart(2, '0')}`), element('span', `phase-card__status phase-card__status--${status}`, STATUS_LABELS[status]));
    const title = element('h3', 'phase-card__title', phase.title);
    const description = element('p', 'phase-card__description', phase.description);
    const progress = element('div', 'phase-card__progress');
    progress.append(element('span', '', 'Phase progress'), element('strong', '', `${summary.percent}%`));
    const track = element('div', 'progress-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `Phase ${phase.number} completion`);
    track.setAttribute('aria-valuenow', String(summary.percent));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = element('span', 'progress-track__fill');
    fill.style.width = `${summary.percent}%`;
    track.append(fill);
    const list = element('ul', 'phase-card__tasks');
    list.append(...phase.featuredTaskIds.map((id) => taskRow(selected.find((task) => task.id === id))));
    card.append(header, title, description, progress, track, list);
    return card;
  });
  replace('phase-grid', ...cards);
}

function renderWorking(tasks) {
  const active = tasks.filter((task) => task.status === 'in_progress');
  replace('working-list', ...active.map((task) => {
    const row = element('li');
    row.append(element('strong', '', task.title), element('span', '', task.clientDescription));
    return row;
  }));
}

function renderRequirements() {
  const items = CLIENT_REQUIREMENTS.map((requirement) => {
    const status = requirement.status;
    const row = element('li', 'requirement');
    const marker = element('span', `requirement__marker requirement__marker--${status}`, status === 'verified' ? '✓' : '');
    marker.setAttribute('aria-hidden', 'true');
    row.append(marker, element('span', 'requirement__name', requirement.title), element('span', `requirement__state requirement__state--${status}`, REQUIREMENT_LABELS[status]));
    return row;
  });
  replace('requirements-list', ...items);
}

function renderNextSteps(tasks) {
  const steps = [
    { id: 'whatsapp-access', text: 'Receive the required Meta access and channel details' },
    { id: 'whatsapp-live-proof', text: 'Connect channels and run live messaging tests' },
    { id: 'email-live-proof', text: 'Verify real invitation and recovery email' },
    { id: 'client-uat', text: 'Complete client acceptance' },
    { id: 'approved-launch', text: 'Validate production, then launch and hand over' },
  ].filter((step) => tasks.find((task) => task.id === step.id).status !== 'completed');
  replace('next-steps-list', ...steps.map((step) => element('li', '', step.text)));
}

function renderDeliverables(tasks) {
  replace('deliverables-list', ...DELIVERABLES.map((deliverable) => {
    const status = deliverableStatus(deliverable, tasks);
    const row = element('li', 'deliverable');
    row.append(element('span', `deliverable__marker deliverable__marker--${status}`, status === 'completed' ? '✓' : '○'), element('span', '', deliverable.title));
    return row;
  }));
}

function init() {
  validatePlan(PROJECT_DAYS, CURRENT_PROJECT_DAY, CATEGORY_LABELS, DELIVERABLES);
  const tasks = tasksOf(PROJECT_DAYS);
  validatePhases(PROJECT_PHASES, tasks, CLIENT_REQUIREMENTS);
  const total = summarize(tasks);
  const activePhase = currentPhase(PROJECT_PHASES, tasks);
  const activeStatus = statusOfPhase(phaseTasks(activePhase, tasks));

  replace('overall-percent', `${total.percent}%`);
  replace('current-phase', `Phase ${activePhase.number} of ${PROJECT_PHASES.length}`);
  replace('completed-stat', String(total.completed));
  replace('remaining-stat', String(total.remaining));
  replace('project-status', STATUS_LABELS[activeStatus]);
  document.getElementById('overall-fill').style.width = `${total.percent}%`;
  document.getElementById('overall-progress').setAttribute('aria-valuenow', String(total.percent));
  renderPhases(tasks, activePhase);
  renderWorking(tasks);
  renderRequirements();
  renderNextSteps(tasks);
  renderDeliverables(tasks);
}

init();
