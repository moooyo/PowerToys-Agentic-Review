/* MUI choice controls mirror the original inputs without duplicating model events. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider } from '@mui/material/styles';
import Checkbox from '@mui/material/Checkbox';
import Radio from '@mui/material/Radio';
import Switch from '@mui/material/Switch';

const choiceSelector = 'input[type="checkbox"], input[type="radio"]';
const switchSetting = /^repo\.[^.]+\.(static|e2e|autoRepliesEnabled|progressEnabled)$/;
const ariaAttributes = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-errormessage', 'aria-invalid', 'aria-required', 'aria-controls', 'aria-details'];

const choiceSx = {
  width: 48,
  height: 48,
  padding: '12px',
  flexShrink: 0,
  color: 'var(--md-on-surface-variant)',
  '&.Mui-checked, &.MuiCheckbox-indeterminate': { color: 'var(--md-primary)' },
  '&:hover': { backgroundColor: 'var(--md-hover)' },
  '&:active': { backgroundColor: 'var(--md-pressed)' },
  '&.Mui-focusVisible': { outline: '3px solid var(--md-primary)', outlineOffset: 2 },
  '&.Mui-disabled': { color: 'color-mix(in srgb, var(--md-on-surface) 38%, transparent)' },
  '@media (hover: none)': { '&:hover': { backgroundColor: 'transparent' } },
};

const switchSx = {
  '--ar-choice-color': 'var(--md-primary)',
  '--ar-choice-on-color': 'var(--md-on-primary)',
  '--ar-choice-outline': 'var(--md-outline)',
  width: 64,
  height: 48,
  padding: '8px 6px',
  overflow: 'visible',
  flexShrink: 0,
  '& .MuiSwitch-switchBase': {
    top: 2,
    padding: '14px',
    color: 'var(--ar-choice-outline)',
    transition: 'transform 160ms ease, padding 160ms ease',
    '&:hover': { backgroundColor: 'var(--md-hover)' },
    '&:active': { backgroundColor: 'var(--md-pressed)' },
    '&.Mui-focusVisible': { outline: '3px solid var(--md-primary)', outlineOffset: 2 },
    '&.Mui-checked': {
      transform: 'translateX(20px)',
      padding: '10px',
      color: 'var(--ar-choice-on-color)',
      '& .MuiSwitch-thumb': { width: 24, height: 24 },
      '& + .MuiSwitch-track': { opacity: 1, backgroundColor: 'var(--ar-choice-color)', borderColor: 'var(--ar-choice-color)' },
    },
    '&.Mui-disabled': { color: 'var(--md-on-surface)', opacity: 0.38 },
    '&.Mui-checked.Mui-disabled': { color: 'var(--md-surface)', opacity: 1 },
    '&.Mui-disabled + .MuiSwitch-track': { opacity: 0.12, backgroundColor: 'var(--md-on-surface)', borderColor: 'var(--md-on-surface)' },
    '@media (hover: none)': { '&:hover': { backgroundColor: 'transparent' } },
  },
  '& .MuiSwitch-thumb': { width: 16, height: 16, boxShadow: 'none', transition: 'width 160ms ease, height 160ms ease' },
  '& .MuiSwitch-track': { boxSizing: 'border-box', borderRadius: '16px', border: '2px solid var(--ar-choice-outline)', backgroundColor: 'var(--md-surface-high)', opacity: 1 },
  '@media (prefers-reduced-motion: reduce)': { '& .MuiSwitch-switchBase, & .MuiSwitch-thumb, & .MuiSwitch-track': { transition: 'none' } },
};

export function createMaterialChoiceControls({ themes, getMode }) {
  const records = new Set();
  const bySource = new WeakMap();
  let sequence = 0;
  let scope;
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (scope?.isConnected) sync(scope); });
  }

  function kindOf(source) {
    if (source.type === 'radio') return 'radio';
    if (source.dataset.materialKind === 'checkbox') return 'checkbox';
    return source.dataset.materialKind === 'switch' || switchSetting.test(source.dataset.ops || '') ? 'switch' : 'checkbox';
  }

  function model(record) {
    const { source } = record;
    const aria = Object.fromEntries(ariaAttributes.filter(name => source.hasAttribute(name)).map(name => [name, source.getAttribute(name)]));
    return {
      kind: kindOf(source),
      mode: getMode(),
      checked: source.checked,
      indeterminate: source.indeterminate,
      disabled: source.disabled || source.matches(':disabled') || source.getAttribute('aria-disabled') === 'true',
      readOnly: source.readOnly,
      required: source.required,
      value: source.value,
      name: source.type === 'radio' && source.name ? `ar-material-choice-${source.name}` : undefined,
      form: source.getAttribute('form') || undefined,
      sourceId: source.id,
      aria,
    };
  }

  function applyChange(record, checked) {
    const { source } = record;
    if (!record.active || !source.isConnected || source.disabled || source.matches(':disabled') || source.readOnly || source.getAttribute('aria-disabled') === 'true') return;
    if (source.checked === checked && !source.indeterminate) return;
    source.checked = checked;
    source.indeterminate = false;
    // Native radio grouping updates the other original inputs before the model sees this event.
    source.dispatchEvent(new Event('change', { bubbles: true }));
    schedule();
  }

  function Choice({ record, data }) {
    const Component = data.kind === 'switch' ? Switch : data.kind === 'radio' ? Radio : Checkbox;
    const error = data.aria['aria-invalid'] === 'true';
    const sx = data.kind === 'switch' ? {
      ...switchSx,
      ...(error ? {
        '--ar-choice-color': themes[data.mode].palette.error.main,
        '--ar-choice-on-color': themes[data.mode].palette.error.contrastText,
        '--ar-choice-outline': themes[data.mode].palette.error.main,
      } : {}),
    } : {
      ...choiceSx,
      ...(error ? { color: 'error.main', '&.Mui-checked, &.MuiCheckbox-indeterminate': { color: 'error.main' } } : {}),
    };
    return <ThemeProvider theme={themes[data.mode]}>
      <Component
        id={record.controlId}
        checked={data.checked}
        disabled={data.disabled}
        readOnly={data.readOnly}
        required={data.required}
        value={data.value}
        name={data.name}
        color={error ? 'error' : 'primary'}
        tabIndex={record.tabIndex}
        {...(data.kind === 'checkbox' ? { indeterminate: data.indeterminate } : {})}
        slotProps={{ input: {
          ...data.aria,
          ...(data.kind === 'switch' ? { role: 'switch' } : {}),
          form: data.form,
          'data-material-source': data.sourceId,
          onClick: event => { if (data.readOnly) event.preventDefault(); },
        } }}
        onChange={event => applyChange(record, event.target.checked)}
        sx={sx}
      />
    </ThemeProvider>;
  }

  function paint(record) {
    if (!record.active || !record.source.isConnected || !record.host.isConnected) return;
    const data = model(record);
    const signature = JSON.stringify(data);
    record.host.dataset.materialKind = data.kind;
    if (!record.failed && record.signature !== signature) {
      try {
        flushSync(() => record.reactRoot.render(<Choice record={record} data={data} />));
        record.signature = signature;
      } catch {
        record.failed = true;
      }
    }
    applyPresentation(record);
  }

  function applyPresentation(record) {
    const control = record.host.querySelector('input');
    const graphic = record.host.dataset.materialKind === 'switch'
      ? record.host.querySelector('.MuiSwitch-thumb') && record.host.querySelector('.MuiSwitch-track')
      : record.host.querySelector('svg');
    const ready = !record.failed && control?.id === record.controlId && Boolean(graphic) && record.host.getClientRects().length > 0;
    if (record.presented === ready) return;
    record.presented = ready;
    if (ready) {
      record.source.hidden = true;
      record.source.setAttribute('aria-hidden', 'true');
      record.source.tabIndex = -1;
      record.source.classList.add('ar-material-choice-source');
      for (const { label } of record.labels) { label.htmlFor = record.controlId; label.classList.add('ar-material-choice-label'); }
    } else {
      for (const [name, value] of Object.entries(record.attributes)) restoreAttribute(record.source, name, value);
      if (!record.hadSourceClass) record.source.classList.remove('ar-material-choice-source');
      for (const { label, htmlFor, hadClass } of record.labels) {
        restoreAttribute(label, 'for', htmlFor);
        if (!hadClass) label.classList.remove('ar-material-choice-label');
      }
      if (record.failed) record.host.hidden = true;
    }
  }

  function restoreAttribute(node, name, value) {
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }

  function retire(record) {
    if (!record.active) return;
    record.active = false;
    records.delete(record);
    bySource.delete(record.source);
    record.source.removeEventListener('change', schedule);
    for (const [name, descriptor] of Object.entries(record.methods)) {
      if (record.source[name] !== record.proxies[name]) continue;
      if (descriptor) Object.defineProperty(record.source, name, descriptor);
      else delete record.source[name];
    }
    for (const [name, value] of Object.entries(record.attributes)) restoreAttribute(record.source, name, value);
    if (!record.hadSourceClass) record.source.classList.remove('ar-material-choice-source');
    for (const { label, htmlFor, hadClass } of record.labels) {
      if (label.htmlFor === record.controlId) restoreAttribute(label, 'for', htmlFor);
      if (!hadClass) label.classList.remove('ar-material-choice-label');
    }
    record.host.remove();
    // Dialog guards retain detached DOM fragments; retire the old root before rehydrating them.
    queueMicrotask(() => record.reactRoot.unmount());
  }

  function enhance(source) {
    let record = bySource.get(source);
    if (source.hasAttribute('data-material-native')) { if (record) retire(record); return; }
    if (record && (!record.host.isConnected || record.host.parentNode !== source.parentNode)) { retire(record); record = null; }
    if (record) { paint(record); return; }
    if (source.hidden || !source.parentElement || source.closest('.ar-material-choice-host')) return;
    if (!source.id) source.id = `ar-material-choice-source-${++sequence}`;
    const host = document.createElement('span');
    host.className = 'ar-material-choice-host';
    record = {
      source,
      host,
      controlId: `${source.id}--material-choice`,
      tabIndex: source.tabIndex,
      labels: Array.from(source.labels || []).map(label => ({ label, htmlFor: label.getAttribute('for'), hadClass: label.classList.contains('ar-material-choice-label') })),
      attributes: Object.fromEntries(['hidden', 'aria-hidden', 'tabindex'].map(name => [name, source.getAttribute(name)])),
      methods: Object.fromEntries(['focus', 'scrollIntoView'].map(name => [name, Object.getOwnPropertyDescriptor(source, name)])),
      proxies: {},
      hadSourceClass: source.classList.contains('ar-material-choice-source'),
      active: true,
      signature: '',
      presented: null,
      failed: false,
      nativeFocus: source.focus.bind(source),
      nativeScroll: source.scrollIntoView.bind(source),
    };
    source.after(host);
    record.proxies.focus = options => { paint(record); if (record.presented) record.host.querySelector('input')?.focus(options); else record.nativeFocus(options); };
    record.proxies.scrollIntoView = options => record.presented ? record.host.scrollIntoView(options) : record.nativeScroll(options);
    Object.assign(source, record.proxies);
    record.reactRoot = createRoot(host, { onUncaughtError: () => { record.failed = true; if (record.active) applyPresentation(record); } });
    // Only the original input's synthetic change may reach the prototype model.
    for (const type of ['input', 'change']) host.addEventListener(type, event => event.stopPropagation());
    source.addEventListener('change', schedule);
    records.add(record);
    bySource.set(source, record);
    paint(record);
  }

  function sync(root) {
    if (!root) return;
    scope = root;
    for (const record of Array.from(records)) {
      if (!root.contains(record.source) || !root.contains(record.host)) retire(record);
    }
    for (const source of root.querySelectorAll(choiceSelector)) {
      if (!source.closest('.ar-material-choice-host')) enhance(source);
    }
  }

  return { sync };
}
