import type { TemplateLibraryItem } from '../api/channels.js';
import { h } from '../dom.js';
import { normalizeSearchText } from '@convo/domain';
import type { AppState } from '../state.js';
import { badge, button, dialogShell, inlineError, notice, selectControl } from './parts.js';
import { t } from './copy.js';

function toggle(state: AppState, key: string, label: string, checked?: boolean): HTMLElement {
  const selected = checked ?? state.dialogForm[key] === 'true';
  return button({ label, act: 'form-toggle', arg: `${key}:${String(!selected)}`, pressed: selected, variant: selected ? 'primary' : 'default', small: true });
}
export function filterLibrary(state: AppState, templates: readonly TemplateLibraryItem[]): readonly TemplateLibraryItem[] {
  const search = normalizeSearchText(state.dialogForm['librarySearch'] ?? '');
  const filters = ['language', 'category', 'connectionId', 'visibility'] as const;
  return templates.filter((row) => (!search || normalizeSearchText(`${row.name} ${row.body} ${row.connectionName} ${row.language} ${row.category}`).includes(search)) &&
    filters.every((key) => !state.dialogForm[`libraryFilter_${key}`] || row[key] === state.dialogForm[`libraryFilter_${key}`]));
}
export function templateLibraryDialog(state: AppState): HTMLElement {
  const resource = state.live.templateLibrary;
  const library = resource.status === 'ready' ? resource.value : null;
  const templates = library?.templates ?? [];
  const filtered = filterLibrary(state, templates);
  const picked = templates.filter((row) => state.dialogForm[`libraryPick_${row.id}`] === 'true');
  const focused = templates.find((row) => row.id === state.dialogForm['libraryPreview']) ?? picked[0] ?? filtered[0];
  const teams = library?.teams ?? [];
  const visibility = state.dialogForm['libraryVisibility'] ?? 'all';
  const busy = state.live.busy !== null;
  return dialogShell(state, t(state, 'مكتبة القوالب والتيمات', 'Template library & teams'), [
    resource.status === 'loading' ? h('p', { role: 'status' }, [t(state, 'جارٍ تحميل المكتبة…', 'Loading library…')]) : null,
    resource.status === 'error' ? inlineError(state, resource.error) : null,
    library === null ? null : h('div', { class: 'template-library' }, [
      h('div', { class: 'template-library__search' }, [
        h('label', { class: 'field' }, [h('span', { class: 'field__label' }, [t(state, 'ابحث عن قالب', 'Find a template')]), h('input', { class: 'input', type: 'search', value: state.dialogForm['librarySearch'] ?? '', placeholder: t(state, 'اسم القالب، نص الرسالة، أو رقم الإرسال…', 'Template name, message text, or sending line…'), 'data-act': 'form-toggle', 'data-form': 'librarySearch' })]),
        h('div', { class: 'template-library__filters' }, [
          ...(['language','category','connectionId','visibility'] as const).map((key) => selectControl({ act: 'form-toggle', form: `libraryFilter_${key}`, value: state.dialogForm[`libraryFilter_${key}`] ?? '', ariaLabel: key, options: [{ value: '', label: key === 'language' ? t(state, 'كل اللغات', 'All languages') : key === 'category' ? t(state, 'كل الفئات', 'All categories') : key === 'connectionId' ? t(state, 'كل أرقام الإرسال', 'All sending lines') : t(state, 'كل الإتاحات', 'All access') }, ...[...new Set(templates.map((row) => row[key]))].map((value) => ({ value, label: key === 'connectionId' ? templates.find((row) => row.connectionId === value)!.connectionName : key === 'visibility' ? value === 'all' ? t(state,'للجميع','Everyone') : t(state,'تيمات محددة','Selected teams') : value }))] })),
        ]),
      ]),
      h('div', { class: 'template-library__workspace' }, [
        h('section', { class: 'template-library__catalog', 'aria-label': t(state, 'القوالب', 'Templates') }, [
          h('div', { class: 'template-library__count', role: 'status' }, [t(state, `${filtered.length} من ${templates.length} قالب · ${picked.length} محدد`, `${filtered.length} of ${templates.length} templates · ${picked.length} selected`),
            button({ label: t(state,'تحديد النتائج','Select results'), act: 'live-template-library-pick-results', small: true, disabled: filtered.length === 0 || busy }),
            button({ label: t(state,'مسح التحديد','Clear selection'), act: 'live-template-library-clear', variant: 'ghost', small: true, disabled: picked.length === 0 || busy }),
          ]),
          filtered.length === 0 ? notice('info','info',t(state,'لا توجد نتائج. غيّر البحث أو الفلاتر، أو زامن القوالب من القنوات.','No matches. Change the search or filters, or sync templates from Channels.')) : null,
          ...filtered.map((row) => h('article', { class: `template-library__card${state.dialogForm[`libraryPick_${row.id}`] === 'true' ? ' is-selected' : ''}` }, [
            h('div', { class: 'template-library__cardhead' }, [toggle(state,`libraryPick_${row.id}`,state.dialogForm[`libraryPick_${row.id}`] === 'true' ? t(state,'محدد','Selected') : t(state,'تحديد','Select')), button({ label: row.name, act: 'live-template-library-edit', arg: row.id, variant: 'ghost' })]),
            h('p', { class: 'template-library__body', dir: 'auto' }, [row.body]),
            h('div', { class: 'template-library__meta' }, [badge(row.language,'neutral'), badge(row.category,'neutral'), badge(row.status,row.status === 'approved' ? 'success' : 'warning'), h('span', {}, [row.connectionName])]),
            h('p', { class: 'field__hint' }, [row.visibility === 'all' ? t(state,'متاح للجميع','Available to everyone') : row.teamIds.map((id) => teams.find((team) => team.id === id)?.name ?? t(state,'تيم مؤرشف','Archived team')).join(' · ') || t(state,'لا يوجد تيم نشط','No active team')]),
          ])),
        ]),
        h('aside', { class: 'template-library__settings' }, [
          h('h3', {}, [t(state,'من يستخدم القوالب المحددة؟','Who can use the selected templates?')]),
          h('p', { class: 'field__hint' }, [t(state,'التعديل يستبدل الإتاحة للقوالب المحددة فقط. الأدمن يحتفظ بإمكانية استخدام كل القوالب.','Changes replace access for selected templates only. Administrators retain access to every template.')]),
          h('div', { class: 'template-library__modes' }, [button({label:t(state,'الجميع','Everyone'),act:'form-toggle',arg:'libraryVisibility:all',pressed:visibility === 'all',variant:visibility === 'all' ? 'primary' : 'default'}), button({ label:t(state,'تيمات محددة','Selected teams'),act:'form-toggle',arg:'libraryVisibility:teams',pressed:visibility === 'teams',variant:visibility === 'teams' ? 'primary' : 'default' })]),
          visibility === 'teams' ? h('div', { class: 'template-library__teams' }, [
            teams.length === 0 ? notice('info','info',t(state,'أنشئ تيمًا من Teams أولًا.','Create a team from Teams first.')) : null,
            ...teams.map((team) => toggle(state,`libraryTeam_${team.id}`,team.name)),
          ]) : null,
          focused === undefined ? null : h('div', { class: 'template-library__preview' }, [h('h4',{},[focused.name]),h('p',{dir:'auto'},[focused.body])]),
        ]),
      ]),
    ]),
    state.formErrors['templateLibrary'] ? notice('warning','alert',state.formErrors['templateLibrary']) : null,
    state.live.error === null ? null : inlineError(state,state.live.error),
  ], [button({label:t(state,'إغلاق','Close'),act:'close-dialog',variant:'ghost',disabled:busy}),button({label:t(state,'تحديث المكتبة','Reload library'),act:'live-template-library-reload',disabled:busy}),button({label:t(state,`حفظ إتاحة ${picked.length} قالب`,`Save access for ${picked.length} templates`),act:'live-template-library-save',variant:'primary',busy:state.live.busy === 'template-access-save',disabled:library === null || picked.length === 0 || picked.length > 200 || busy})], {size:'lg',description:t(state,'اختر القوالب، ثم حدد التيمات التي تظهر لها في المحادثات والإرسال السريع والبرودكاست.','Select templates, then choose which teams can find and use them in conversations, quick messages and broadcasts.')});
}
