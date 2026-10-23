import type { LeadImportPreview } from '../api/campaigns.js';
import type { LeadSheetResult, LeadSheetRow } from '../lead-sheet.js';
import type { AppState } from '../state.js';
import type { LiveContext } from './actions.js';
import { editorAudience } from './audience.js';
import { currentTenantId, rowsOf } from './store.js';

export interface BroadcastUpload {
  readonly fileName: string;
  readonly rows: readonly LeadSheetRow[];
  readonly error: string | null;
  readonly preview: LeadImportPreview | null;
  readonly previewKey: string | null;
}

const uploads = new WeakMap<AppState, BroadcastUpload>();

export function broadcastUpload(state: AppState): BroadcastUpload | null { return uploads.get(state) ?? null; }

/** Reserve the audience as soon as a file is chosen, before Excel parsing can finish. */
export function beginBroadcastUpload(state: AppState, fileName: string): BroadcastUpload {
  const pending = { fileName, rows: [], error: null, preview: null, previewKey: null };
  uploads.set(state, pending);
  return pending;
}

/** Ignore a late parser result after the file was replaced or the wizard closed. */
export function finishBroadcastUpload(state: AppState, pending: BroadcastUpload, parsed: LeadSheetResult): boolean {
  if (uploads.get(state) !== pending || (state.dialog?.kind !== 'campaign' && state.dialog?.kind !== 'campaign-edit')) return false;
  setBroadcastUpload(state, pending.fileName, parsed);
  return true;
}

export function setBroadcastUpload(state: AppState, fileName: string, parsed: LeadSheetResult): void {
  uploads.set(state, parsed.ok
    ? { fileName, rows: parsed.rows, error: null, preview: null, previewKey: null }
    : { fileName, rows: [], error: parsed.message, preview: null, previewKey: null });
}

export function clearBroadcastUpload(state: AppState): void { uploads.delete(state); }

export function uploadKey(state: AppState): string {
  const campaign = state.dialog?.kind === 'campaign-edit'
    ? rowsOf(state.live.campaigns).find((entry) => entry.id === state.dialog?.arg) : undefined;
  const name = (state.dialogForm['campaignName'] ?? campaign?.name ?? '').trim();
  return `${editorAudience(state).connectionId}|${name}`;
}

export async function previewBroadcastUpload(context: LiveContext): Promise<boolean> {
  const { state, live } = context;
  const upload = broadcastUpload(state);
  const tenantId = currentTenantId(live);
  if (upload === null || upload.rows.length === 0 || tenantId === null) return false;
  const key = uploadKey(state);
  const separator = key.indexOf('|');
  const connectionId = key.slice(0, separator);
  const campaignName = key.slice(separator + 1);
  if (connectionId === '' || campaignName === '') {
    uploads.set(state, { ...upload, error: 'Name the broadcast and choose a WhatsApp number first.', preview: null, previewKey: null });
    context.refresh();
    return false;
  }
  live.busy = 'broadcast-import-preview';
  context.refresh();
  const result = await live.campaignsApi.previewLeads(tenantId, { connectionId, campaignName, rows: upload.rows });
  live.busy = null;
  if (uploads.get(state) !== upload) return false;
  uploads.set(state, result.ok
    ? { ...upload, error: null, preview: result.data, previewKey: key }
    : { ...upload, error: result.error.message, preview: null, previewKey: null });
  context.refresh();
  return result.ok;
}
