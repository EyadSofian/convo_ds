import type { EntityMetadata, FieldTarget } from '../api/metadata.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { metadataFieldValue } from '../live/dispatch.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { button, field, isolated, selectControl, textInput } from './parts.js';

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

/** Labels and typed values for one record, backed by the server catalogue. */
export function metadataSection(
  state: AppState,
  live: LiveState,
  target: FieldTarget,
  entity: { readonly id: string } & EntityMetadata,
): HTMLElement {
  const busy = live.busy === `metadata:${target}:${entity.id}`;
  // Keep rolling deployments readable while an older API response is still in
  // a browser cache. The new server always sends both arrays; absence means an
  // empty projection, never a reason to take down the entire Inbox.
  const entityLabels = entity.labels ?? [];
  const entityFields = entity.customFields ?? [];
  const labels = rowsOf(live.labels).filter((entry) => entry.state === 'active');
  const assigned = new Set(entityLabels.map((entry) => entry.id));
  const available = labels.filter((entry) => !assigned.has(entry.id));
  const fields = rowsOf(live.customFields).filter(
    (entry) => entry.target === target && entry.state === 'active',
  );

  const headingId = `metadata-${target}-${entity.id}`;
  return h('section', { class: 'panel-section metadata', 'data-metadata': target, 'aria-labelledby': headingId }, [
    h('h3', { class: 'panel-section__title', id: headingId }, [
      target === 'contact' ? t(state, 'تصنيفات العميل وحقوله', 'Contact labels & fields') : t(state, 'تصنيفات المحادثة وحقولها', 'Conversation labels & fields'),
    ]),
    entityLabels.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'بلا تصنيف.', 'No labels.')])
      : h('div', { class: 'metadata__labels' }, entityLabels.map((label) =>
          // The colour is the company's own data, so it is set per label rather
          // than taken from the palette.
          h('span', { class: 'metadata__label', style: `--label-color:${label.color}` }, [
            h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }),
            isolated(label.name),
            button({
              icon: 'close',
              act: 'live-metadata-label',
              arg: `${target}|${entity.id}|${label.id}|remove`,
              variant: 'ghost',
              small: true,
              disabled: busy,
              title: t(state, `إزالة التصنيف ${label.name}`, `Remove label ${label.name}`),
              extraClass: 'metadata__remove',
            }),
          ]),
        )),
    available.length === 0
      ? null
      : field(
          t(state, 'إضافة تصنيف', 'Add label'),
          selectControl({
            value: '',
            form: `${target}|${entity.id}`,
            act: 'live-metadata-label',
            ariaLabel: t(state, 'إضافة تصنيف', 'Add label'),
            disabled: busy,
            options: [
              { value: '', label: t(state, 'اختر…', 'Choose…') },
              ...available.map((entry) => ({ value: entry.id, label: entry.name })),
            ],
          }),
        ),
    fields.length === 0
      ? null
      : h('div', { class: 'metadata__fields' }, fields.map((definition) => {
          const entry = entityFields.find((value) => value.fieldId === definition.id);
          const current = entry === undefined ? '' : Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value);
          const key = metadataFieldValue(target, entity.id, definition.id);
          return h('div', { class: 'metadata__field' }, [
            field(
              definition.name,
              fieldControl(state, definition.type, definition.options, key, state.dialogForm[key] ?? current),
              definition.key,
            ),
            button({
              label: t(state, 'حفظ', 'Save'),
              act: 'live-metadata-field',
              arg: `${target}|${entity.id}|${definition.id}`,
              small: true,
              disabled: busy,
            }),
          ]);
        })),
  ]);
}

function fieldControl(
  state: AppState,
  type: string,
  options: readonly string[],
  key: string,
  value: string,
): Child {
  if (type === 'boolean') {
    return selectControl({
      value,
      form: key,
      ariaLabel: key,
      options: [
        { value: '', label: t(state, 'غير محدد', 'Not set') },
        { value: 'true', label: t(state, 'نعم', 'Yes') },
        { value: 'false', label: t(state, 'لا', 'No') },
      ],
    });
  }
  if (type === 'single_select') {
    return selectControl({
      value,
      form: key,
      ariaLabel: key,
      options: [{ value: '', label: t(state, 'غير محدد', 'Not set') }, ...options.map((option) => ({ value: option, label: option }))],
    });
  }
  const input = textInput(key, value, type === 'multi_select' ? t(state, 'افصل القيم بفاصلة', 'Comma-separated values') : '');
  if (type === 'number') input.type = 'number';
  if (type === 'date') input.type = 'date';
  return input;
}
