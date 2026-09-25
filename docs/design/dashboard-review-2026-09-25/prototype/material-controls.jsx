/* MUI renders the select surface and menu; existing controls retain model events. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { createMaterialChoiceControls } from './material-choice-controls.jsx';
import { createMaterialActionEffects } from './material-action-effects.jsx';

const records = new Set();
const bySource = new WeakMap();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let sequence = 0;
let scheduled = false;
let observer;

const themes = Object.fromEntries(['light', 'dark'].map(mode => {
  const dark = mode === 'dark';
  return [mode, createTheme({
    palette: {
      mode,
      primary: { main: dark ? '#B2C7FF' : '#345EAD' },
      error: { main: dark ? '#F2B8B5' : '#B3261E' },
      background: { paper: dark ? '#20252F' : '#FFFFFF' },
      text: { primary: dark ? '#E3E5ED' : '#1B1D24', secondary: dark ? '#BAC2D0' : '#505966' },
      divider: dark ? '#414A58' : '#D4DAE5',
    },
    shape: { borderRadius: 4 },
    typography: { fontFamily: 'Roboto, "Segoe UI", Arial, sans-serif', fontSize: 14 },
    components: {
      MuiFormControl: { defaultProps: { variant: 'outlined', fullWidth: true } },
      MuiInputLabel: { styleOverrides: { root: { fontSize: '1rem' } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { minHeight: 56, borderRadius: 4, fontSize: '1rem', lineHeight: 1.5 },
          notchedOutline: { borderColor: dark ? '#8994A5' : '#737D8C' },
        },
      },
      MuiSelect: { styleOverrides: { select: { padding: '16px 40px 16px 14px', minHeight: '24px', display: 'flex', alignItems: 'center' } } },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: 48, padding: '12px 16px', fontSize: '1rem', whiteSpace: 'normal',
            '&.Mui-selected': { backgroundColor: dark ? '#303A50' : '#DFE6F4' },
            '&.Mui-selected:hover': { backgroundColor: dark ? '#3B4760' : '#D3DEEF' },
          },
        },
      },
    },
  })];
}));

function mode() {
  const scheme = document.getElementById('ar-m3-prototype')?.style.colorScheme;
  return scheme === 'dark' || (scheme !== 'light' && media.matches) ? 'dark' : 'light';
}

const choices = createMaterialChoiceControls({ themes, getMode: mode });
const actionEffects = createMaterialActionEffects({ themes, getMode: mode });

function labelText(source, wrapper) {
  const direct = Array.from(wrapper.childNodes)
    .filter(node => node !== source && (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN' && !node.classList.contains('ar-inline-error')))
    .map(node => node.textContent).join(' ').trim();
  return source.dataset.materialLabel || direct || source.getAttribute('aria-label') || 'Choose an option';
}

function model(record) {
  const source = record.source;
  return {
    mode: mode(),
    label: record.label,
    value: source.value,
    disabled: source.disabled,
    error: source.getAttribute('aria-invalid') === 'true',
    describedBy: source.getAttribute('aria-describedby') || undefined,
    ariaLabel: source.getAttribute('aria-label') || record.label,
    options: Array.from(source.options).filter(option => !option.hidden).map(option => ({
      value: option.value, label: option.textContent, disabled: option.disabled || option.parentElement?.disabled,
    })),
  };
}

function Control({ record, data }) {
  const labelId = record.source.id + '--material-label';
  const controlId = record.source.id + '--material-control';
  const value = data.options.some(option => option.value === data.value) ? data.value : '';
  return <ThemeProvider theme={themes[data.mode]}>
    <FormControl disabled={data.disabled} error={data.error} className="ar-material-form-control">
      <InputLabel id={labelId} shrink>{data.label}</InputLabel>
      <Select
        id={controlId}
        labelId={labelId}
        label={data.label}
        value={value}
        notched
        displayEmpty
        open={record.open && !data.disabled}
        SelectDisplayProps={{ 'aria-label': data.ariaLabel, 'aria-describedby': data.describedBy, 'aria-invalid': data.error || undefined, 'data-material-source': record.source.id }}
        onOpen={() => { closeMenus(); record.open = true; paint(record, true); }}
        onClose={event => { if (event?.key === 'Escape') event.preventDefault(); record.open = false; paint(record, true); }}
        onChange={event => {
          record.open = false;
          paint(record, true);
          record.source.value = String(event.target.value);
          record.source.dispatchEvent(new Event('change', { bubbles: true }));
          schedule();
        }}
        MenuProps={{
          container: () => record.source.closest('dialog[open]') || document.getElementById('ar-m3-prototype'),
          disableScrollLock: true,
          anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
          transformOrigin: { vertical: 'top', horizontal: 'left' },
          slotProps: {
            paper: { className: 'ar-material-menu', sx: { mt: 0.5, borderRadius: '12px', bgcolor: data.mode === 'dark' ? '#20252F' : '#EDF0F7', maxHeight: 'min(360px, 60vh)', boxShadow: '0 4px 16px rgb(0 0 0 / 18%)' } },
            list: { sx: { py: 1 } },
          },
        }}
      >
        {data.options.map((option, index) => <MenuItem key={option.value + ':' + index} value={option.value} disabled={Boolean(option.disabled)}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
  </ThemeProvider>;
}

function paint(record, force = false) {
  if (!record.source.isConnected || !record.host.isConnected) return;
  const data = model(record);
  const signature = JSON.stringify([data, record.open]);
  if (!force && record.signature === signature) return;
  record.signature = signature;
  flushSync(() => record.reactRoot.render(<Control record={record} data={data} />));
}

function closeMenus() {
  actionEffects.closeTooltips();
  for (const record of records) {
    if (record.open) { record.open = false; paint(record, true); }
  }
}

function enhanceSelect(source) {
  let record = bySource.get(source);
  if (record) { paint(record); return; }
  const originalWrapper = source.parentElement;
  if (!originalWrapper || originalWrapper.closest('.ar-material-form-control')) return;
  if (!source.id) source.id = 'ar-material-source-' + (++sequence);
  const label = labelText(source, originalWrapper);
  let wrapper = originalWrapper;
  if (wrapper.tagName === 'LABEL') {
    wrapper = document.createElement('div');
    for (const attribute of originalWrapper.attributes) {
      if (attribute.name !== 'for') wrapper.setAttribute(attribute.name, attribute.value);
    }
    while (originalWrapper.firstChild) wrapper.append(originalWrapper.firstChild);
    originalWrapper.replaceWith(wrapper);
  }
  for (const child of Array.from(wrapper.childNodes)) {
    if (child === source) break;
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SPAN') child.remove();
  }
  wrapper.querySelector(':scope > .ar-mui-select-host')?.remove();
  wrapper.classList.add('ar-mui-container');
  const host = document.createElement('div');
  host.className = 'ar-mui-select-host';
  source.after(host);
  source.classList.add('ar-mui-native');
  source.dataset.materialLabel = label;
  source.setAttribute('aria-hidden', 'true');
  source.tabIndex = -1;
  record = { source, host, label, reactRoot: createRoot(host), open: false, signature: '' };
  source.focus = options => host.querySelector('[role="combobox"]')?.focus(options);
  bySource.set(source, record);
  records.add(record);
  paint(record, true);
}

function enhanceTextFields(root) {
  for (const wrapper of root.querySelectorAll('label.ar-field:not(.ar-outlined-field)')) {
    const control = Array.from(wrapper.children).find(child => child.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea'));
    if (!control) continue;
    const label = labelText(control, wrapper);
    if (!label) continue;
    for (const child of Array.from(wrapper.childNodes)) {
      if (child === control) break;
      if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SPAN') child.remove();
    }
    const caption = document.createElement('span');
    caption.className = 'ar-floating-label';
    caption.textContent = label;
    wrapper.prepend(caption);
    wrapper.classList.add('ar-outlined-field');
  }
  for (const wrapper of root.querySelectorAll('label.ar-outlined-field')) updateFieldState(wrapper);
}

function updateFieldState(wrapper) {
  const control = Array.from(wrapper.children).find(child => child.matches('input,textarea'));
  if (!control) return;
  const floated = control === document.activeElement || Boolean(control.value || control.placeholder) || ['date', 'time', 'datetime-local', 'month', 'week'].includes(control.type);
  wrapper.classList.toggle('ar-field-floated', floated);
  wrapper.classList.toggle('ar-field-disabled', control.disabled);
  wrapper.classList.toggle('ar-field-readonly', control.readOnly);
}

function sync() {
  scheduled = false;
  const root = document.getElementById('ar-m3-prototype');
  if (!root) return;
  for (const record of Array.from(records)) {
    if (!record.source.isConnected) {
      records.delete(record); bySource.delete(record.source);
      queueMicrotask(() => record.reactRoot.unmount());
    }
  }
  for (const source of root.querySelectorAll('select')) enhanceSelect(source);
  enhanceTextFields(root);
  choices.sync(root);
  actionEffects.sync(root);
  if (!observer) {
    observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-invalid', 'aria-describedby', 'style', 'selected', 'checked', 'readonly'] });
  }
}

function schedule() {
  if (!scheduled) { scheduled = true; queueMicrotask(sync); }
}

media.addEventListener('change', schedule);
document.addEventListener('change', event => { if (event.target.matches('select.ar-mui-native')) schedule(); });
for (const type of ['input', 'focusin', 'focusout']) document.addEventListener(type, event => {
  const wrapper = event.target.closest?.('label.ar-outlined-field');
  if (wrapper) queueMicrotask(() => { if (wrapper.isConnected) updateFieldState(wrapper); });
});
window.ARMaterialControls = { sync, closeMenus };
