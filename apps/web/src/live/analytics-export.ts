import { pushToast } from '../state.js';
import { allSheets, sheetsFor } from '../ui/analytics-sheets.js';
import { csv, workbook } from '../xlsx.js';
import type { LiveContext } from './actions.js';
import {
  loadAssignmentReport,
  loadCampaignReport,
  loadOperationalReport,
  loadResolutionReport,
  loadResponseReport,
  loadTeamReport,
} from './campaign-actions.js';
import { forTenant } from './store.js';

/**
 * Taking analytics away as files, made in the browser from the reports the
 * server already sent: the open report as a CSV, or every report as one
 * Excel workbook with a sheet per table. Nothing is recomputed — the files
 * hold the same figures the charts draw, under the same filters.
 */

/** Pages of the ownership log read for a workbook, at 50 rows each. */
const ASSIGNMENT_PAGES = 20;

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/** Hands the browser a file to save. */
export function saveFile(name: string, type: string, data: BlobPart): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Reads every report the workbook holds that has not been read yet. */
async function loadEverything(context: LiveContext): Promise<void> {
  const live = context.live;
  if (live.campaignReport.status !== 'ready') await loadCampaignReport(context);
  if (live.operationalReport.status !== 'ready') await loadOperationalReport(context);
  if (live.teamReport.status !== 'ready') await loadTeamReport(context);
  if (live.responseReport.status !== 'ready') await loadResponseReport(context);
  if (live.resolutionReport.status !== 'ready') await loadResolutionReport(context);
  if (live.assignmentReport.status !== 'ready') await loadAssignmentReport(context);
  for (let page = 1; page < ASSIGNMENT_PAGES && live.assignmentReport.status === 'ready' && live.assignmentNextCursor !== null; page += 1) {
    await loadAssignmentReport(context, true);
  }
}

export async function exportAnalytics(context: LiveContext, format: string): Promise<boolean> {
  if (format !== 'csv' && format !== 'xlsx') return false;
  return forTenant(context, false, async () => {
    const { live, state } = context;
    live.busy = 'analytics-export';
    context.refresh();
    if (format === 'xlsx') await loadEverything(context);
    live.busy = null;
    const sheets = format === 'xlsx' ? allSheets(state) : sheetsFor(state, state.analyticsView);
    if (sheets.length === 0) {
      pushToast(state, t(context, 'لا توجد أرقام لتصديرها بعد. انتظر حتى يكتمل التقرير.', 'There are no figures to export yet. Wait for the report to load.'), 'danger');
      context.refresh();
      return false;
    }
    const day = new Date(context.now()).toISOString().slice(0, 10);
    if (format === 'xlsx') {
      saveFile(`convo-analytics-${day}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        workbook(sheets, { rightToLeft: state.lang === 'ar', at: new Date(context.now()) }));
    } else {
      saveFile(`convo-analytics-${state.analyticsView}-${day}.csv`, 'text/csv;charset=utf-8', csv(sheets));
    }
    pushToast(state, format === 'xlsx'
      ? t(context, `تم تنزيل ملف Excel فيه ${String(sheets.length)} ورقة.`, `Downloaded an Excel workbook with ${String(sheets.length)} sheets.`)
      : t(context, 'تم تنزيل ملف CSV لهذا التقرير.', 'Downloaded this report as a CSV.'));
    context.refresh();
    return true;
  });
}

/** The page as it is, through the browser's print dialog — where "Save as PDF" lives. */
export function printAnalytics(view: { print?: () => void } | null): boolean {
  if (view === null || typeof view.print !== 'function') return false;
  view.print();
  return true;
}
