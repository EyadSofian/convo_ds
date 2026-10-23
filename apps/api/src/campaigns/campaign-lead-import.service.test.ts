import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import { CampaignLeadImportService, normalizeLeadMobile, parseLeadImport, parseLeadOutcome, type LeadImportInput } from './campaign-lead-import.service';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const SESSION = {} as AuthenticatedSession;
const INPUT: LeadImportInput = { connectionId: CONNECTION, campaignName: 'PMP October', rows: [
  { leadName: 'Mona', mobile: '01012345678', courseName: 'PMP', label: 'PMP', assignTo: 'mona@school.test', campaignName: 'PMP October' },
] };

function harness(answer: (statement: string, values: readonly unknown[]) => readonly unknown[] = () => []) {
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => ({ rows: answer(statement, values), rowCount: 1 }));
  const sql = { query } as unknown as SqlExecutor;
  const requirePermission = vi.fn(async (...args: [SqlExecutor, AuthenticatedSession, string]) => { void args; return {}; });
  const authorization = {
    assertTenantId: vi.fn(), requirePermission,
    withPrincipal: vi.fn(async (_session: AuthenticatedSession, _tenant: string, work: (context: unknown) => Promise<unknown>) => work({ sql, principal: { membershipId: 'member-1' } })),
  } as unknown as AuthorizationService;
  return { service: new CampaignLeadImportService(authorization), query, requirePermission };
}

function ordinary(statement: string): readonly unknown[] {
  if (statement.includes('FROM channel_connections')) return [{ kind: 'whatsapp' }];
  if (statement.includes('FROM labels WHERE state')) return [{ name: 'pmp' }];
  if (statement.includes('FROM memberships')) return [{ id: 'member-1', name: 'Mona Agent', email: 'mona@school.test' }];
  if (statement.includes('FROM campaigns WHERE')) return [{ name: 'PMP October', connection_id: CONNECTION, control_state: 'draft' }];
  if (statement.includes('FROM campaign_leads WHERE campaign_id')) return [];
  if (statement.includes('FROM labels WHERE tenant_id')) return [{ id: 'label-1' }];
  if (statement.includes('INSERT INTO contacts')) return [{ id: 'contact-1' }];
  return [];
}

describe('campaign lead import boundary', () => {
  it('accepts only valid outcome transitions and requires a reason for lost leads', () => {
    expect(parseLeadOutcome({ status: 'won', revenueAmountMinor: 125050 })).toEqual({
      status: 'won', lostReason: null, revenueAmountMinor: 125050, currency: 'EGP',
    });
    expect(parseLeadOutcome({ status: 'lost', lostReason: 'no_interest' }).status).toBe('lost');
    expect(() => parseLeadOutcome({ status: 'lost' })).toThrow();
    expect(() => parseLeadOutcome({ status: 'new', revenueAmountMinor: 1 })).toThrow();
    expect(() => parseLeadOutcome({ status: 'won', revenueAmountMinor: -1 })).toThrow();
    expect(() => parseLeadOutcome({ status: 'won', revenueAmountMinor: 1.5 })).toThrow();
    expect(() => parseLeadOutcome({ status: 'contacted', lostReason: 'no_answer' })).toThrow();
    expect(() => parseLeadOutcome([])).toThrow();
    expect(() => parseLeadOutcome(null)).toThrow();
  });

  it('checks campaign access before listing imported leads', async () => {
    const { service, requirePermission } = harness((statement) => statement.includes('SELECT connection_id::text FROM campaigns')
      ? [{ connection_id: CONNECTION }] : []);
    expect(await service.listLeads(SESSION, TENANT, CAMPAIGN)).toEqual([]);
    expect(requirePermission.mock.calls.map((call) => call[2])).toEqual(['campaign.read']);
  });

  it('does not expose a missing campaign or a lead outside that campaign', async () => {
    const { service } = harness(() => []);
    await expect(service.listLeads(SESSION, TENANT, CAMPAIGN)).rejects.toThrow('Campaign not found');
    await expect(service.updateOutcome(SESSION, TENANT, CAMPAIGN, CONNECTION,
      parseLeadOutcome({ status: 'contacted' }))).rejects.toThrow('Campaign lead not found');
  });

  it('normalizes Egyptian national and explicit international numbers', () => {
    expect(normalizeLeadMobile('010 1234 5678')).toBe('201012345678');
    expect(normalizeLeadMobile('+20 (10) 1234-5678')).toBe('201012345678');
    expect(normalizeLeadMobile('00201012345678')).toBe('201012345678');
    expect(normalizeLeadMobile('1012345678')).toBe('201012345678');
    expect(normalizeLeadMobile('1234')).toBeNull();
    expect(normalizeLeadMobile('0101234567x')).toBeNull();
    expect(normalizeLeadMobile('441234567890')).toBeNull();
    expect(normalizeLeadMobile('+441234567890')).toBe('441234567890');
    expect(normalizeLeadMobile('+1212345678')).toBe('1212345678');
    expect(normalizeLeadMobile('001212345678')).toBe('1212345678');
  });

  it('refuses overlarge or malformed payloads', () => {
    expect(() => parseLeadImport({ connectionId: 'bad', campaignName: 'Test', rows: [] })).toThrow();
    expect(() => parseLeadImport(null)).toThrow();
    expect(() => parseLeadImport({ ...INPUT, rows: [null] })).toThrow();
    expect(() => parseLeadImport({ ...INPUT, rows: [{ ...INPUT.rows[0], mobile: 123 }] })).toThrow();
    expect(parseLeadImport({ ...INPUT, campaignName: ' PMP October ', rows: [{ ...INPUT.rows[0], leadName: ' Mona ' }] })).toMatchObject({ campaignName: 'PMP October', rows: [{ leadName: 'Mona' }] });
  });

  it('reports missing values, invalid mobiles, duplicate rows, wrong campaign and ambiguous agents before import', async () => {
    const { service } = harness((statement) => ordinary(statement));
    const preview = await service.preview(SESSION, TENANT, { ...INPUT, rows: [
      { ...INPUT.rows[0]!, leadName: '' },
      { ...INPUT.rows[0]!, mobile: 'bad' },
      { ...INPUT.rows[0]!, campaignName: 'Other', assignTo: 'missing', mobile: '01012345678' },
      { ...INPUT.rows[0]!, mobile: '+201012345678' },
      { ...INPUT.rows[0]!, mobile: '01112345678', courseName: 'x'.repeat(161) },
    ] });
    expect(preview).toMatchObject({ totalRows: 5, missingRequiredFields: 1, invalidMobileNumbers: 1, duplicateLeads: 1, readyToSend: 0 });
    expect(preview.issues.map((issue) => issue.code)).toEqual(['missing', 'mobile', 'campaign', 'assignee', 'duplicate', 'length']);
  });

  it('imports one clean lead, checks permissions and keeps the link idempotent', async () => {
    const { service, query, requirePermission } = harness(ordinary);
    const imported = await service.commit(SESSION, TENANT, CAMPAIGN, INPUT);
    expect(imported).toMatchObject({ contactIds: ['contact-1'], preview: { readyToSend: 1, newContacts: 1 } });
    expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO campaign_leads'))).toBe(true);
    expect(requirePermission.mock.calls.map((call) => call[2])).toEqual(['campaign.draft', 'contact.edit']);
    const replay = harness((statement) => statement.includes('FROM campaign_leads WHERE campaign_id')
      ? [{ mobile: '201012345678', contact_id: 'contact-1' }] : ordinary(statement));
    expect(await replay.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).toMatchObject({ contactIds: ['contact-1'] });
  });

  it('rejects a disconnected number, mismatched draft, different imported sheet and colliding identity', async () => {
    const disconnected = harness(() => []);
    await expect(disconnected.service.preview(SESSION, TENANT, INPUT)).rejects.toThrow('connected WhatsApp');
    const mismatch = harness((statement) => statement.includes('FROM campaigns WHERE')
      ? [{ name: 'Another', connection_id: CONNECTION, control_state: 'draft' }] : ordinary(statement));
    await expect(mismatch.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('Campaign Name');
    const missing = harness((statement) => statement.includes('FROM campaigns WHERE') ? [] : ordinary(statement));
    await expect(missing.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('do not match');
    const wrongNumber = harness((statement) => statement.includes('FROM campaigns WHERE')
      ? [{ name: 'PMP October', connection_id: 'other', control_state: 'draft' }] : ordinary(statement));
    await expect(wrongNumber.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('do not match');
    const locked = harness((statement) => statement.includes('FROM campaigns WHERE')
      ? [{ name: 'PMP October', connection_id: CONNECTION, control_state: 'running' }] : ordinary(statement));
    await expect(locked.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('draft');
    const audience = harness((statement) => statement.includes('FROM campaign_leads WHERE campaign_id')
      ? [{ mobile: '201112345678', contact_id: 'contact-2' }] : ordinary(statement));
    await expect(audience.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('another imported audience');
    const identity = harness((statement) => statement.includes('FROM contact_identities WHERE kind')
      ? [{ contact_id: 'contact-2' }] : ordinary(statement));
    await expect(identity.service.commit(SESSION, TENANT, CAMPAIGN, INPUT)).rejects.toThrow('another contact');
    const invalid = harness(ordinary);
    await expect(invalid.service.commit(SESSION, TENANT, CAMPAIGN, { ...INPUT, rows: [{ ...INPUT.rows[0]!, mobile: 'bad' }] })).rejects.toThrow('Fix the invalid lead rows');
    const ambiguous = harness((statement) => statement.includes('SELECT DISTINCT hit.contact_id')
      ? [{ contact_id: 'contact-1' }, { contact_id: 'contact-2' }] : ordinary(statement));
    await expect(ambiguous.service.preview(SESSION, TENANT, INPUT)).rejects.toThrow('multiple contacts');
  });

  it('survives a concurrent label insertion while importing an international lead', async () => {
    const international = { ...INPUT, rows: [{ ...INPUT.rows[0]!, mobile: '+441234567890' }] };
    let labelReads = 0;
    const { service, query } = harness((statement) => {
      if (statement.includes('FROM labels WHERE tenant_id')) return labelReads++ === 0 ? [] : [{ id: 'label-1' }];
      if (statement.includes('INSERT INTO labels')) return [];
      return ordinary(statement);
    });
    expect(await service.commit(SESSION, TENANT, CAMPAIGN, international)).toMatchObject({ contactIds: ['contact-1'] });
    expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO labels'))).toBe(true);
  });
});
