import type { Collaborator, Conversation, Handoff } from '../api/conversations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { futureTime, relativeTime } from '../format.js';
import type { RoutingAbility } from '../live/ability.js';
import { currentMembership } from '../live/ability.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { badge, button, emptyState, errorState, isolated, sectionTitle, selectControl, skeleton } from './parts.js';
import type { Tone } from './parts.js';

/**
 * Who holds the conversation, and the three ways that changes.
 *
 * The controls are deliberately not interchangeable, because the acts are not
 * (ADR-0017). **Assign** puts work on somebody's desk whether they agreed or
 * not, and only somebody with routing authority sees it. **Ask** offers it to a
 * colleague who may decline, and is what an Agent gets instead. A pending offer
 * is a banner rather than a changed assignee, because until it is answered the
 * conversation has not moved.
 *
 * Nothing here decides authorization. The controls a caller cannot use are
 * absent because showing a button that always refuses teaches an operator that
 * the software is unreliable — but the server decides regardless, and a refusal
 * is rendered beside the control that caused it with its `request_id`.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const PRIORITY_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  low: { ar: 'منخفضة', en: 'Low' },
  normal: { ar: 'عادية', en: 'Normal' },
  high: { ar: 'مرتفعة', en: 'High' },
  urgent: { ar: 'عاجلة', en: 'Urgent' },
};

const PRIORITY_TONE: Readonly<Record<string, Tone>> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function priorityLabel(state: AppState, priority: string): string {
  const entry = PRIORITY_LABEL[priority];
  return entry === undefined ? priority : t(state, entry.ar, entry.en);
}

export function priorityBadge(state: AppState, priority: string): HTMLElement {
  return badge(priorityLabel(state, priority), PRIORITY_TONE[priority] ?? 'neutral', { icon: 'flag' });
}

/* ------------------------------------------------------------- the panel -- */

export function routingSection(
  state: AppState,
  live: LiveState,
  conversation: Conversation,
  ability: RoutingAbility,
): Child {
  if (!ability.mayAssign && !ability.mayAsk) {
    return null;
  }
  return h('section', { class: 'routing panel-section', 'aria-labelledby': 'routing-heading' }, [
    sectionTitle('assign', 'blue', t(state, 'الإسناد', 'Assignment'), 'routing-heading'),
    assigneeLine(state, live, conversation, ability),
    pendingOffer(state, live, conversation),
    routingForm(state, live, conversation, ability),
    collaboratorList(state, live, ability),
  ]);
}

function assigneeLine(
  state: AppState,
  live: LiveState,
  conversation: Conversation,
  ability: RoutingAbility,
): HTMLElement {
  const busy = live.busy === `routing:${conversation.id}`;
  return h('div', { class: 'routing__current' }, [
    h('p', { class: 'routing__assignee' }, [
      h('span', { class: 'routing__key' }, [t(state, 'المسؤول', 'Assignee')]),
      conversation.assigneeMembershipId === null
        ? // Said in words, not left blank: "unassigned" is a state somebody has
          // to act on, and an empty field reads as a loading failure.
          h('span', { class: 'routing__nobody' }, [t(state, 'لا أحد بعد', 'Nobody yet')])
        : isolated(assigneeLabel(state, live, conversation.assigneeMembershipId)),
    ]),
    h('div', { class: 'routing__actions' }, [
      priorityBadge(state, conversation.priority),
      ability.mayAssign
        ? button({
            label: t(state, 'إسناد', 'Assign'),
            act: 'live-routing-open',
            arg: 'assign',
            small: true,
            expanded: live.routingPanel === 'assign',
            disabled: busy,
          })
        : null,
      ability.mayAsk
        ? button({
            label: t(state, 'اطلب من زميل', 'Ask a colleague'),
            act: 'live-routing-open',
            arg: 'handoff',
            small: true,
            expanded: live.routingPanel === 'handoff',
            disabled: busy,
          })
        : null,
      !ability.mayAssign && ability.mayAsk && conversation.assigneeMembershipId === currentMembership(live)?.id
        ? button({
            label: t(state, 'ترك المحادثة', 'Unclaim'),
            act: 'live-routing-release-own',
            small: true,
            variant: 'ghost',
            disabled: busy,
          })
        : null,
      ability.mayAssign
        ? button({
            label: t(state, 'الأولوية', 'Priority'),
            act: 'live-routing-open',
            arg: 'priority',
            small: true,
            variant: 'ghost',
            expanded: live.routingPanel === 'priority',
            disabled: busy,
          })
        : null,
    ]),
  ]);
}

/**
 * Who holds the conversation, in words.
 *
 * The directory is only loaded when a picker opens, so the name may not be
 * known yet. A membership id is never shown instead: it means nothing to an
 * operator, and "a colleague" is the honest thing to say until the name loads.
 */
function assigneeLabel(state: AppState, live: LiveState, membershipId: string): string {
  if (currentMembership(live)?.id === membershipId) {
    return t(state, 'أنت', 'You');
  }
  if (live.assignees.status === 'ready') {
    const match = live.assignees.value.find((entry) => entry.membershipId === membershipId);
    if (match !== undefined) {
      return match.label;
    }
  }
  if (live.collaborators.status === 'ready') {
    const match = live.collaborators.value.find((entry) => entry.membershipId === membershipId);
    if (match !== undefined) {
      return match.label;
    }
  }
  return t(state, 'زميل في الفريق', 'A colleague');
}

/* -------------------------------------------------------- pending offer -- */

/**
 * The offer nobody has answered yet.
 *
 * A banner rather than a changed assignee, because the conversation has not
 * moved: somebody is still responsible for the customer, and it is whoever was
 * responsible before. The expiry is shown as the future it is; the timer here
 * is presentation, and the server's stored instant is what actually expires it.
 */
function pendingOffer(state: AppState, live: LiveState, conversation: Conversation): Child {
  if (live.handoffs.status !== 'ready') {
    return null;
  }
  const offer = live.handoffs.value.find((entry) => entry.state === 'pending');
  if (offer === undefined) {
    return null;
  }
  const mine = offeredToMe(live, offer);
  const busy = live.busy === `handoff:${offer.id}`;
  return h('div', { class: 'routing__offer', role: 'status', 'data-handoff': offer.id }, [
    h('p', { class: 'routing__offertext' }, [
      mine
        ? t(state, 'طُلب منك استلام هذه المحادثة.', 'You have been asked to take this conversation.')
        : `${t(state, 'بانتظار ردّ', 'Waiting on')} ${offer.toLabel}`,
    ]),
    offer.note === null ? null : h('p', { class: 'routing__offernote' }, [isolated(offer.note)]),
    h('p', { class: 'routing__offerwhen' }, [
      `${t(state, 'تنتهي المهلة', 'Expires')} ${futureTime(offer.expiresAt, state.clock, state.lang)}`,
    ]),
    h('div', { class: 'routing__actions' }, [
      mine
        ? button({
            label: t(state, 'أستلمها', 'Take it'),
            act: 'live-handoff-settle',
            arg: `${offer.id}:accept`,
            small: true,
            variant: 'primary',
            disabled: busy,
          })
        : null,
      mine
        ? button({
            label: t(state, 'أعتذر', 'Decline'),
            act: 'live-handoff-settle',
            arg: `${offer.id}:decline`,
            small: true,
            disabled: busy,
          })
        : null,
      mine
        ? null
        : button({
            label: t(state, 'سحب الطلب', 'Withdraw'),
            act: 'live-handoff-settle',
            arg: `${offer.id}:cancel`,
            small: true,
            variant: 'ghost',
            disabled: busy,
          }),
    ]),
    // The conversation is still whoever's it was. Said out loud, because a
    // pending request is exactly the moment somebody assumes it moved.
    h('p', { class: 'field__hint' }, [
      conversation.assigneeMembershipId === null
        ? t(state, 'لم تُسند بعد.', 'It is not assigned to anybody yet.')
        : t(state, 'تبقى المحادثة مع صاحبها حتى يوافق.', 'It stays with its current assignee until they accept.'),
    ]),
  ]);
}

/* -------------------------------------------------------------- the form -- */

function routingForm(
  state: AppState,
  live: LiveState,
  conversation: Conversation,
  ability: RoutingAbility,
): Child {
  const open = live.routingPanel;
  if (open === null || open === 'collaborators') {
    return null;
  }
  // One guard, because there is one question: may this person use the control
  // this form belongs to? Three separate checks would be three places for the
  // answer to drift from the buttons above.
  if (!(open === 'handoff' ? ability.mayAsk : ability.mayAssign)) {
    return null;
  }
  const busy = live.busy === `routing:${conversation.id}`;
  return h('form', { class: 'routing__form', 'data-routing': open }, [
    h('p', { class: 'routing__prompt' }, [promptFor(state, open)]),
    ...(open === 'priority'
      ? [priorityChoices(state, conversation, busy)]
      : [
          peoplePicker(state, live, open),
          open === 'handoff'
            ? h('textarea', {
                class: 'input routing__note',
                rows: '2',
                maxlength: '1000',
                'data-act': 'live-handoff-note',
                'aria-label': t(state, 'سبب الطلب', 'Why you are asking'),
                placeholder: t(state, 'اختياري: لماذا هي أنسب لك؟', 'Optional: why them?'),
              }, [live.handoffNote])
            : null,
        ]),
    h('div', { class: 'routing__formactions' }, [
      button({
        label: t(state, 'إلغاء', 'Cancel'),
        act: 'live-routing-close',
        small: true,
        variant: 'ghost',
      }),
      ...(open === 'assign' && conversation.assigneeMembershipId !== null
        ? [
            button({
              label: t(state, 'رفع الإسناد', 'Unassign'),
              act: 'live-routing-unassign',
              small: true,
              disabled: busy,
            }),
          ]
        : []),
      open === 'priority'
        ? null
        : button({
            label: open === 'assign' ? t(state, 'إسناد', 'Assign') : t(state, 'إرسال الطلب', 'Ask'),
            act: open === 'assign' ? 'live-routing-assign' : 'live-routing-ask',
            small: true,
            variant: 'primary',
            disabled: busy || live.routingChoice === '',
          }),
    ]),
  ]);
}

function promptFor(state: AppState, panel: 'assign' | 'handoff' | 'priority'): string {
  if (panel === 'assign') {
    return t(
      state,
      'تنتقل المحادثة فورًا إلى من تختاره، سواء وافق أم لا.',
      'The conversation moves to whoever you choose, whether or not they agreed.',
    );
  }
  if (panel === 'handoff') {
    return t(
      state,
      'يصل الطلب إلى زميلك وله أن يعتذر. تبقى المحادثة معك حتى يوافق.',
      'Your colleague gets a request and may decline. It stays with you until they accept.',
    );
  }
  return t(
    state,
    'الأولوية ترتيب في الطابور، لا وعد بموعد.',
    'Priority is a position in the queue, not a promise about time.',
  );
}

function priorityChoices(
  state: AppState,
  conversation: Conversation,
  busy: boolean,
): HTMLElement {
  return h(
    'div',
    { class: 'routing__priorities', role: 'group', 'aria-label': t(state, 'الأولوية', 'Priority') },
    PRIORITIES.map((value) =>
      button({
        label: priorityLabel(state, value),
        act: 'live-routing-priority',
        arg: value,
        small: true,
        pressed: conversation.priority === value,
        disabled: busy,
      }),
    ),
  );
}

/**
 * The people who could take this conversation.
 *
 * Its own loading, empty, denied and failed states, because it is a separate
 * request from the conversation and an empty list is a real answer — "nobody in
 * this inbox can take it" is a staffing fact somebody needs to see, not a bug.
 */
function peoplePicker(state: AppState, live: LiveState, panel: 'assign' | 'handoff'): Child {
  const resource = live.assignees;
  if (resource.status === 'idle' || resource.status === 'loading') {
    return skeleton(state, 1);
  }
  if (resource.status === 'error') {
    return h('div', {}, [
      errorState(state, resource.error),
      button({ label: t(state, 'إعادة المحاولة', 'Try again'), act: 'live-routing-open', arg: panel, small: true }),
    ]);
  }
  const options = resource.value.filter((entry) => !entry.assigned);
  if (options.length === 0) {
    return emptyState({
      icon: 'users',
      title: t(state, 'لا يوجد زميل متاح', 'Nobody available'),
      body: t(state, 'لا يملك زميل آخر صلاحية العمل على هذه المحادثة.', 'No other colleague has access to work this conversation.'),
    });
  }
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label' }, [t(state, 'الزميل', 'Colleague')]),
    // Its own action rather than the generic form collector: the confirm button
    // is disabled until somebody is chosen, so the choice has to reach the
    // renderer rather than sitting in a form bag the screen never reads.
    selectControl({
      value: live.routingChoice,
      act: 'live-routing-choice',
      ariaLabel: t(state, 'الزميل', 'Colleague'),
      options: [
        { value: '', label: t(state, 'اختر زميلًا', 'Choose a colleague') },
        ...options.map((entry) => ({ value: entry.membershipId, label: entry.label })),
      ],
    }),
  ]);
}

/* ---------------------------------------------------------- collaborators -- */

/**
 * The people invited to help.
 *
 * `participated` is shown because it changes what removal means: somebody who
 * actually wrote in the conversation keeps permitted read access to what they
 * wrote, and the control says so rather than implying the removal erases them.
 */
function collaboratorList(state: AppState, live: LiveState, ability: RoutingAbility): Child {
  const resource = live.collaborators;
  if (resource.status !== 'ready') {
    return null;
  }
  if (resource.value.length === 0 && !ability.mayAssign) {
    return null;
  }
  return h('div', { class: 'routing__collaborators' }, [
    h('p', { class: 'routing__key' }, [t(state, 'يساعد أيضًا', 'Also helping')]),
    resource.value.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا أحد.', 'Nobody.')])
      : h(
          'ul',
          { class: 'routing__collablist' },
          resource.value.map((entry) => collaboratorRow(state, live, entry, ability)),
        ),
    ability.mayAssign
      ? button({
          label: t(state, 'أضف زميلًا', 'Invite somebody'),
          act: 'live-routing-open',
          arg: 'collaborators',
          small: true,
          variant: 'ghost',
          expanded: live.routingPanel === 'collaborators',
        })
      : null,
    live.routingPanel === 'collaborators' && ability.mayAssign
      ? h('div', { class: 'routing__form' }, [
          peoplePicker(state, live, 'assign'),
          h('div', { class: 'routing__formactions' }, [
            button({
              label: t(state, 'إلغاء', 'Cancel'),
              act: 'live-routing-close',
              small: true,
              variant: 'ghost',
            }),
            button({
              label: t(state, 'إضافة', 'Invite'),
              act: 'live-collaborator-add',
              small: true,
              variant: 'primary',
              disabled: live.routingChoice === '',
            }),
          ]),
        ])
      : null,
  ]);
}

function collaboratorRow(
  state: AppState,
  live: LiveState,
  entry: Collaborator,
  ability: RoutingAbility,
): HTMLElement {
  return h('li', { class: 'routing__collab' }, [
    isolated(entry.label),
    h('span', { class: 'routing__collabwhen' }, [
      relativeTime(entry.addedAt, state.clock, state.lang),
    ]),
    entry.participated
      ? // Not a decoration: it changes what removing them does, and the tooltip
        // says which half survives.
        badge(t(state, 'شارك بالفعل', 'Has taken part'), 'success')
      : null,
    ability.mayAssign
      ? button({
          label: t(state, 'إنهاء', 'End'),
          act: 'live-collaborator-remove',
          arg: entry.membershipId,
          small: true,
          variant: 'ghost',
          disabled: live.busy === `collaborator:${entry.membershipId}`,
          title: entry.participated
            ? t(
                state,
                'ينتهي الوصول المستقبلي. ما كتبه يبقى منسوبًا إليه ويظل يقرؤه.',
                'Future access ends. What they wrote stays theirs, and they keep reading it.',
              )
            : t(state, 'ينتهي وصولهم لهذه المحادثة.', 'Their access to this conversation ends.'),
        })
      : null,
  ]);
}

/* ------------------------------------------------------------- the moved -- */

/**
 * What to show when a re-read said this conversation is no longer readable.
 *
 * It is a normal outcome of routing rather than an error: accepting a handoff
 * moves a conversation *away* from somebody, and a supervisor can reassign one
 * out from under whoever is reading it. The thread is cleared rather than left
 * on screen from cache — another agent's timeline is not this agent's to keep.
 */
export function movedAway(state: AppState): HTMLElement {
  return emptyState({
    icon: 'lock',
    tone: 'denied',
    title: t(state, 'انتقلت هذه المحادثة', 'This conversation moved'),
    body: t(state, 'لم تعد لديك صلاحية قراءتها. اختر محادثة أخرى من القائمة.', 'You no longer have access to it. Pick another conversation from the list.'),
    action: { label: t(state, 'تحديث القائمة', 'Refresh the list'), act: 'live-inbox-reload' },
  });
}

/** Whether the offer on screen is addressed to this person. */
export function offeredToMe(live: LiveState, offer: Handoff): boolean {
  return currentMembership(live)?.id === offer.toMembershipId;
}
