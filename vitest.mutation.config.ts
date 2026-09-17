import { defineConfig } from 'vitest/config';

// Mutation testing is deliberately focused on pure, high-consequence decision
// code. Database and browser orchestration retain their integration/E2E gates;
// mutating those whole graphs would mostly measure process startup time rather
// than the assertions protecting business decisions.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/src/client-address.test.ts',
      'apps/api/src/channels/meta-whatsapp.transport.test.ts',
      'packages/domain/src/automations/schedule.test.ts',
      'packages/domain/src/automations/workflow.test.ts',
      'packages/domain/src/email/messages.test.ts',
    ],
  },
});
