/**
 * Client-safe source of truth for the read-only portal.
 * The original stage numbers are retained for task identity and internal planning,
 * not displayed by the client portal. They are not historical dates.
 */
export const CURRENT_PROJECT_DAY = 2;

export const CATEGORY_LABELS = {
  core: 'Core Platform',
  inbox: 'Inbox',
  channels: 'Channels',
  campaigns: 'Campaigns',
  automation: 'Automation',
  analytics: 'Analytics',
  experience: 'UI / UX',
  delivery: 'QA & Deployment',
};

export const PROJECT_DAYS = [
  {
    day: 1,
    title: 'Foundation & access',
    summary: 'Establish the secure workspace and product foundations.',
    outcome: 'A reliable foundation for the customer operations workspace.',
    tasks: [
      { id: 'foundation', title: 'Core product structure', clientDescription: 'The main application and supporting services are established.', status: 'completed', category: 'core' },
      { id: 'workspace-access', title: 'Secure workspace access', clientDescription: 'Sign-in, users, teams and roles are in place.', status: 'completed', category: 'core' },
      { id: 'customer-data', title: 'Customer data foundation', clientDescription: 'Customer and conversation records have a structured foundation.', status: 'completed', category: 'core' },
    ],
  },
  {
    day: 2,
    title: 'Conversation operations',
    summary: 'Bring daily conversation work into one focused place.',
    outcome: 'Operators can review and manage a conversation in one workspace.',
    tasks: [
      { id: 'unified-inbox', title: 'Unified Inbox and contacts', clientDescription: 'A shared conversation queue and customer profiles are available.', status: 'completed', category: 'inbox' },
      { id: 'conversation-actions', title: 'Core conversation actions', clientDescription: 'Assignment, private notes, labels, priority and status changes are available.', status: 'completed', category: 'inbox' },
      { id: 'operator-review', title: 'Final operator walkthrough', clientDescription: 'Reviewing the finished conversation experience before acceptance.', status: 'in_progress', category: 'inbox' },
    ],
  },
  {
    day: 3,
    title: 'Realtime & teamwork',
    summary: 'Keep agents in sync while conversations move between people.',
    outcome: 'A team can coordinate work without losing conversation context.',
    tasks: [
      { id: 'live-updates', title: 'Live conversation updates', clientDescription: 'The workspace can update when conversation activity changes.', status: 'completed', category: 'inbox' },
      { id: 'team-handoff', title: 'Team handoff workflow', clientDescription: 'Agents can transfer work with a visible history.', status: 'completed', category: 'inbox' },
      { id: 'team-acceptance', title: 'Team workflow acceptance', clientDescription: 'Review the real team setup and access rules together.', status: 'blocked', category: 'core', clientActionRequired: 'Confirm the agent roster, team memberships and who may see each team’s conversations.' },
    ],
  },
  {
    day: 4,
    title: 'WhatsApp connection',
    summary: 'Prepare and validate the first live messaging channel.',
    outcome: 'An approved WhatsApp account can exchange a controlled test message.',
    tasks: [
      { id: 'channel-management', title: 'Channel management', clientDescription: 'The channel setup and status experience is prepared.', status: 'completed', category: 'channels' },
      { id: 'whatsapp-access', title: 'WhatsApp Business access', clientDescription: 'Authorized account access is needed to connect the live channel.', status: 'blocked', category: 'channels', clientActionRequired: 'Provide approved WhatsApp Business account access, a safe test recipient and the planned message templates through the agreed secure channel.' },
      { id: 'whatsapp-live-proof', title: 'Live message validation', clientDescription: 'Confirm a real incoming message, reply and delivery updates.', status: 'blocked', category: 'channels', dependency: 'WhatsApp Business access' },
    ],
  },
  {
    day: 5,
    title: 'Campaigns & audiences',
    summary: 'Prepare a controlled campaign journey from draft to delivery.',
    outcome: 'A small approved audience can receive and track a safe test campaign.',
    tasks: [
      { id: 'campaign-workflow', title: 'Campaign workflow', clientDescription: 'Drafting, approval, scheduling and delivery tracking are prepared.', status: 'completed', category: 'campaigns' },
      { id: 'audience-safety', title: 'Audience safeguards', clientDescription: 'Eligibility and exclusions are checked before sending.', status: 'completed', category: 'campaigns' },
      { id: 'campaign-trial', title: 'Controlled campaign trial', clientDescription: 'Run a small approved live test before any wider use.', status: 'blocked', category: 'campaigns', dependency: 'Live WhatsApp connection and approved recipients' },
    ],
  },
  {
    day: 6,
    title: 'Automation',
    summary: 'Set up repeatable journeys with clear controls and tracking.',
    outcome: 'A single-recipient automation can be safely reviewed and tested.',
    tasks: [
      { id: 'automation-builder', title: 'Automation builder', clientDescription: 'Reusable flows and a visual editing experience are available.', status: 'completed', category: 'automation' },
      { id: 'automation-controls', title: 'Execution safeguards', clientDescription: 'Triggers, ordered actions and tracking are prepared.', status: 'completed', category: 'automation' },
      { id: 'automation-live', title: 'Controlled live automation', clientDescription: 'Validate one approved recipient and its outcome.', status: 'blocked', category: 'automation', dependency: 'Live WhatsApp connection and approved recipient' },
    ],
  },
  {
    day: 7,
    title: 'Email & accounts',
    summary: 'Complete account invitations and recovery through real email.',
    outcome: 'A user can receive an invitation and recover access by email.',
    tasks: [
      { id: 'account-flows', title: 'Invitation and recovery flows', clientDescription: 'The account flows and email templates are prepared.', status: 'completed', category: 'core' },
      { id: 'email-access', title: 'Verified sender setup', clientDescription: 'A verified sending domain and email account are needed.', status: 'blocked', category: 'core', clientActionRequired: 'Provide access to the approved email sending account and verified sender domain through the agreed secure channel.' },
      { id: 'email-live-proof', title: 'Real email delivery test', clientDescription: 'Confirm invitation and password recovery arrive and work end to end.', status: 'blocked', category: 'core', dependency: 'Verified sender setup' },
    ],
  },
  {
    day: 8,
    title: 'Reporting',
    summary: 'Turn activity into useful, agreed management views.',
    outcome: 'Key operational and campaign measures are reviewed with the business.',
    tasks: [
      { id: 'campaign-reporting', title: 'Campaign performance view', clientDescription: 'Campaign delivery and outcome reporting is available.', status: 'completed', category: 'analytics' },
      { id: 'operations-reporting', title: 'Operational reporting review', clientDescription: 'Confirm and finish the priority workload and response views.', status: 'upcoming', category: 'analytics' },
      { id: 'report-definitions', title: 'Agree final measures', clientDescription: 'Confirm how response, resolution and team performance should be measured.', status: 'blocked', category: 'analytics', clientActionRequired: 'Confirm priority reporting measures and the agreed definitions for response and resolution time.' },
    ],
  },
  {
    day: 9,
    title: 'Reliability & safety',
    summary: 'Check access, recovery and operational readiness.',
    outcome: 'The service has a tested safety and response plan for launch.',
    tasks: [
      { id: 'access-checks', title: 'Access and safety checks', clientDescription: 'Core access and data-protection tests have been run.', status: 'completed', category: 'delivery' },
      { id: 'recovery-review', title: 'Recovery rehearsal', clientDescription: 'Complete an isolated recovery check and review the results.', status: 'upcoming', category: 'delivery' },
      { id: 'alert-contact', title: 'Launch alert contact', clientDescription: 'A named team must receive and acknowledge launch alerts.', status: 'blocked', category: 'delivery', clientActionRequired: 'Name the on-call contact or approved alert destination for launch monitoring.' },
    ],
  },
  {
    day: 10,
    title: 'Interface finalization',
    summary: 'Review the experience across languages and screen sizes.',
    outcome: 'The operator experience is ready for client acceptance.',
    tasks: [
      { id: 'ui-final-review', title: 'Final interface review', clientDescription: 'The latest visual and functional interface refinements have been verified.', status: 'completed', category: 'experience' },
      { id: 'mobile-language-review', title: 'Mobile and Arabic review', clientDescription: 'Phone layouts and Arabic and English interface clarity have been verified.', status: 'completed', category: 'experience' },
      { id: 'ui-client-signoff', title: 'Interface acceptance', clientDescription: 'Capture feedback and approve the final operator screens.', status: 'upcoming', category: 'experience' },
    ],
  },
  {
    day: 11,
    title: 'QA & client acceptance',
    summary: 'Exercise the complete journey with the people who will use it.',
    outcome: 'The agreed acceptance checklist is signed off.',
    tasks: [
      { id: 'automated-qa', title: 'Automated quality checks', clientDescription: 'Core automated checks and screen tests have passed.', status: 'completed', category: 'delivery' },
      { id: 'client-uat', title: 'Client acceptance session', clientDescription: 'Walk through the agreed day-to-day scenarios together.', status: 'upcoming', category: 'delivery' },
      { id: 'acceptance-fixes', title: 'Acceptance follow-ups', clientDescription: 'Resolve any findings from the joint review.', status: 'upcoming', category: 'delivery' },
    ],
  },
  {
    day: 12,
    title: 'Launch & handover',
    summary: 'Deploy the approved release and transfer operating knowledge.',
    outcome: 'A verified launch, source handover and administrator walkthrough.',
    tasks: [
      { id: 'approved-launch', title: 'Approved live launch', clientDescription: 'Launch only after channel, email, monitoring and acceptance checks pass.', status: 'blocked', category: 'delivery', dependency: 'Approved channel, email, alerting and acceptance gates' },
      { id: 'source-handover', title: 'Source and documentation handover', clientDescription: 'Provide the agreed source and operating documentation.', status: 'upcoming', category: 'delivery' },
      { id: 'admin-handover', title: 'Administrator walkthrough', clientDescription: 'Review account, team and daily operating tasks with the owner.', status: 'upcoming', category: 'delivery' },
    ],
  },
];

export const DELIVERABLES = [
  { title: 'Unified communication workspace', taskIds: ['unified-inbox', 'conversation-actions', 'operator-review'] },
  { title: 'Users and roles', taskIds: ['workspace-access', 'team-acceptance'] },
  { title: 'WhatsApp channel', taskIds: ['channel-management', 'whatsapp-access', 'whatsapp-live-proof'] },
  { title: 'Campaign management', taskIds: ['campaign-workflow', 'audience-safety', 'campaign-trial'] },
  { title: 'Automation', taskIds: ['automation-builder', 'automation-controls', 'automation-live'] },
  { title: 'Reports', taskIds: ['campaign-reporting', 'operations-reporting', 'report-definitions'] },
  { title: 'Source, documentation and launch', taskIds: ['approved-launch', 'source-handover', 'admin-handover'] },
];

/** Presentation groups only. The task statuses above remain the source of truth. */
export const PROJECT_PHASES = [
  {
    number: 1,
    title: 'Platform & Core Operations',
    description: 'The secure workspace, customer records, Inbox and team workflows.',
    days: [1, 2, 3, 10],
    featuredTaskIds: ['workspace-access', 'unified-inbox', 'conversation-actions', 'operator-review', 'team-acceptance'],
  },
  {
    number: 2,
    title: 'Channels, Campaigns & Automation',
    description: 'WhatsApp, Facebook and Instagram readiness, plus campaigns, automation and email.',
    days: [4, 5, 6, 7],
    featuredTaskIds: ['channel-management', 'whatsapp-access', 'whatsapp-live-proof', 'campaign-workflow', 'automation-builder', 'email-live-proof'],
  },
  {
    number: 3,
    title: 'Final QA, Launch & Handover',
    description: 'Reporting review, safety checks, client acceptance and an approved launch.',
    days: [8, 9, 11, 12],
    featuredTaskIds: ['campaign-reporting', 'operations-reporting', 'automated-qa', 'client-uat', 'approved-launch', 'source-handover'],
  },
];

/** These are access prerequisites, not a claim that a live channel is connected. */
export const CLIENT_REQUIREMENTS = [
  { id: 'phone', title: 'Dedicated WhatsApp phone number', status: 'pending', taskId: 'whatsapp-access' },
  { id: 'portfolio', title: 'Meta Business Portfolio access', status: 'pending', taskId: 'whatsapp-access' },
  { id: 'facebook', title: 'Facebook Page access', status: 'pending', taskId: 'whatsapp-access' },
  { id: 'instagram', title: 'Instagram Business access', status: 'pending', taskId: 'whatsapp-access' },
];
