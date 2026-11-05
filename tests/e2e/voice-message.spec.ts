import { expect, test } from '@playwright/test';
import { CONVERSATION, CONNECTION, MEMBERSHIP, installApi } from './support/api';
import { overflowsHorizontally } from './support/workspace';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['microphone'] });
test('records and plays a voice message, inserts emoji, uploads a file and filters by inbox', async ({ page }) => {
  await installApi(page);
  const conversation = { id: CONVERSATION, connectionId: CONNECTION, peerIdentity: '201012345678', contactId: null,
    contactDisplayName: 'A parent', teamId: null, assigneeMembershipId: MEMBERSHIP, status: 'open', priority: 'normal', version: 1,
    waitingSince: null, inboxLabel: 'Digital School', channel: 'whatsapp', participantMembershipIds: [], pendingReason: null,
    snoozedUntil: null, snoozeTimezone: null, resolution: null, resolvedAt: null, lastActivityAt: new Date().toISOString(), ownerState: 'human_active', ownerVersion: 1,
    serviceWindow: { status: 'open', lastCustomerInboundAt: new Date().toISOString(), serviceWindowExpiresAt: new Date(Date.now() + 86400000).toISOString() }, capabilities: { reply: true, note: true } };
  let body: { audio: string; clientMessageId: string } | null = null;
  let uploaded: Buffer | null = null;
  let unassignedFilter = '';
  const secondLine = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const id = '11111111-2222-4333-8444-555555555555';
  await page.route(/\/api\/v1\/tenants\/[^/]+\/conversations(?:[/?]|$)/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/conversations/inboxes')) return route.fulfill({ json: { data: [
      { id: CONNECTION, label: 'Digital School', channel: 'whatsapp', assetSuffix: '222222' },
      { id: secondLine, label: 'Digital School', channel: 'whatsapp', assetSuffix: '333333' },
    ] } });
    if (path.endsWith('/conversations/unassigned')) unassignedFilter = new URL(route.request().url()).searchParams.get('inboxId') ?? '';
    if (path.endsWith('/audio') && body !== null) {
      return route.fulfill({ contentType: 'audio/webm', body: Buffer.from(body.audio, 'base64') });
    }
    if (path.endsWith('/attachments') && route.request().method() === 'POST') {
      uploaded = route.request().postDataBuffer();
      return route.fulfill({ status: 202, json: { data: { id: secondLine } } });
    }
    if (path.endsWith('/conversations')) return route.fulfill({ json: { data: [conversation] } });
    if (path.endsWith(`/conversations/${CONVERSATION}`)) return route.fulfill({ json: { data: conversation } });
    if (path.endsWith('/voice-messages')) { body = route.request().postDataJSON(); return route.fulfill({ status: 202, json: { data: { id } } }); }
    if (path.endsWith('/messages') && route.request().method() === 'GET') {
      const message = { direction: 'out', at: new Date().toISOString(), text: null, author_membership_id: MEMBERSHIP,
        command_state: 'queued', delivery_state: null, delivery_anomaly: null, provider_message_id: null };
      const data = [
        ...(body === null ? [] : [{ ...message, id, content_type: 'audio',
          attachments: [{ type: 'audio', storedMedia: true, filename: 'voice.ogg', isVoice: true }] }]),
        ...(uploaded === null ? [] : [{ ...message, id: secondLine, content_type: 'document',
          attachments: [{ type: 'document', storedMedia: true, filename: 'guide.pdf', isVoice: false }] }]),
      ];
      return route.fulfill({ json: { data } });
    }
    return route.fallback();
  });
  await page.goto(`/#/inbox/${CONVERSATION}?lang=en`);
  await expect(page.getByRole('button', { name: 'Record voice message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  // The actual MediaRecorder needs samples from Chromium's simulated microphone.
  await expect(page.locator('.composer__voice-status')).toContainText('1 / 90');
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByLabel('Recording preview', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/convo-voice-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Send recording', exact: true }).click();
  const player = page.locator('.msg__audio');
  await expect(player).toBeVisible();
  await player.evaluate(async (audio: HTMLAudioElement) => { await audio.play(); });
  expect(await player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  expect(body).not.toBeNull();
  expect(Buffer.from((body as unknown as { audio: string }).audio, 'base64').length).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  await page.getByRole('button', { name: '😊', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reply text', exact: true })).toHaveValue('😊');
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.getByLabel('Attach a file', { exact: true }).setInputFiles({
    name: 'guide.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await expect(page.getByText('guide.pdf', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send attachment', exact: true }).click();
  await expect(page.getByRole('link', { name: 'guide.pdf', exact: true })).toBeVisible();
  expect(uploaded).toEqual(Buffer.from('%PDF-1.4'));
  await page.getByRole('button', { name: 'Filter by inbox', exact: true }).click();
  await page.getByRole('button', { name: /333333/ }).click();
  await expect.poll(() => unassignedFilter).toBe(secondLine);
  await expect(page.getByRole('button', { name: /333333/ })).toBeVisible();
  await page.screenshot({ path: '/tmp/convo-voice-sent.png', fullPage: true });
});
