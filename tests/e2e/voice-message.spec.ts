import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CONVERSATION, CONNECTION, MEMBERSHIP, installApi } from './support/api';
import { overflowsHorizontally } from './support/workspace';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }, permissions: ['microphone'] });

/**
 * A microphone that speaks, built from the page's own audio graph. The browser's
 * fake capture device depends on the machine's audio service and can hang forever
 * where there is none; this is a real MediaStream all the same, so MediaRecorder,
 * the level meter and decoding the result all run for real.
 */
async function installSpeakingMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const voice = context.createOscillator();
      const syllables = context.createOscillator();
      const loudness = context.createGain();
      const depth = context.createGain();
      const output = context.createMediaStreamDestination();
      voice.frequency.value = 220;
      syllables.frequency.value = 3;
      depth.gain.value = 0.5;
      loudness.gain.value = 0.5;
      syllables.connect(depth).connect(loudness.gain);
      voice.connect(loudness).connect(output);
      voice.start();
      syllables.start();
      return output.stream;
    };
  });
}

test('records and plays a voice message, inserts emoji, uploads a file and filters by inbox', async ({ page }, testInfo) => {
  await installApi(page);
  await installSpeakingMicrophone(page);
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
  // The actual MediaRecorder needs samples, and the timer needs a second of them.
  await expect(page.locator('.recorder__time')).toContainText('0:01 / 1:30');
  // The meter is drawn and the microphone (simulated here) moves it.
  await expect(page.locator('.recorder__meter i')).toHaveCount(36);
  await expect.poll(() => page.locator('.recorder__meter').evaluate((meter) =>
    Array.from(meter.children).some((bar) => Number((bar as HTMLElement).style.getPropertyValue('--level')) > 0))).toBe(true);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  const preview = page.getByRole('group', { name: 'Recording preview', exact: true });
  await expect(preview).toBeVisible();
  // The preview plays from memory, before anything has been sent.
  await preview.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(preview.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('voice-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send recording', exact: true }).click();
  const player = page.getByRole('group', { name: 'Voice message', exact: true });
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute('data-status', 'ready');
  // The sent note has a real length and a real waveform, read from its bytes.
  await expect(player.locator('.voice__time')).not.toHaveText('0:00');
  await player.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  // A redraw in the middle of a note must not stop it.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await player.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(body).not.toBeNull();
  expect(Buffer.from((body as unknown as { audio: string }).audio, 'base64').length).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  // Opens upwards in full, inside the window: it used to collapse off the bottom.
  const picker = page.getByRole('dialog', { name: 'Choose an emoji', exact: true });
  const opened = await picker.boundingBox();
  const composer = await page.locator('.composer').boundingBox();
  expect(opened!.height).toBeGreaterThan(100);
  expect(opened!.y + opened!.height).toBeLessThanOrEqual(composer!.y + composer!.height);
  await page.getByRole('button', { name: '😊', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reply text', exact: true })).toHaveValue('😊');
  // The picker stays open for another, and the search finds by word in either language.
  await page.getByRole('searchbox', { name: 'Search emoji', exact: true }).fill('thanks');
  await page.getByRole('button', { name: '🙏', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reply text', exact: true })).toHaveValue('😊🙏');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
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
  await page.screenshot({ path: testInfo.outputPath('voice-sent.png'), fullPage: true });
});
