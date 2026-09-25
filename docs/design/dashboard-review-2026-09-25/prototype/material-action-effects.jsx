/* Add MUI interaction feedback without replacing delegated-action buttons. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider } from '@mui/material/styles';
import TouchRipple from '@mui/material/ButtonBase/TouchRipple';
import Tooltip from '@mui/material/Tooltip';

export function createMaterialActionEffects({ themes, getMode }) {
  const records = new Set();
  const bySource = new WeakMap();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let sequence = 0;

  function description(record, open) {
    const current = record.source.getAttribute('aria-describedby') || '';
    const ids = current.split(/\s+/).filter(id => id && id !== record.tooltipId);
    if (open) ids.push(record.tooltipId);
    const next = ids.join(' ');
    if (next !== current) {
      if (next) record.source.setAttribute('aria-describedby', next);
      else record.source.removeAttribute('aria-describedby');
    }
  }

  function label(source) {
    return source.dataset.tooltip || (source.matches('.ar-icon-button,.ar-avatar,.ar-search-trigger') ? source.getAttribute('aria-label') || '' : '');
  }

  function draw(record, force = false) {
    if (!record.source.isConnected || !record.host.isConnected) return;
    const mode = getMode(), title = label(record.source);
    const signature = JSON.stringify([mode, title, record.open, record.source.disabled]);
    if (!force && record.signature === signature) return;
    record.signature = signature;
    const open = record.open && Boolean(title) && !record.source.disabled;
    description(record, open);
    flushSync(() => record.reactRoot.render(<ThemeProvider theme={themes[mode]}>
      <TouchRipple ref={value => { record.ripple = value; }} />
      {title ? <Tooltip
        id={record.tooltipId}
        title={title}
        open={open}
        placement="top"
        disableFocusListener disableHoverListener disableTouchListener disableInteractive
        slotProps={{
          popper: {
            anchorEl: record.source,
            container: () => record.source.closest('dialog[open]') || document.getElementById('ar-m3-prototype'),
          },
          tooltip: { sx: { borderRadius: '4px', px: 1, py: 0.5, fontSize: '0.75rem', lineHeight: '1rem', bgcolor: mode === 'dark' ? '#E3E5ED' : '#303038', color: mode === 'dark' ? '#303038' : '#F3F4FA' } },
        }}
      ><span className="ar-material-tooltip-anchor" aria-hidden="true" /></Tooltip> : null}
    </ThemeProvider>));
  }

  function hide(record) {
    clearTimeout(record.timer);
    record.open = false;
    draw(record);
  }

  function show(record, delay) {
    clearTimeout(record.timer);
    if (!label(record.source) || record.source.disabled) return;
    record.timer = setTimeout(() => { if (record.source.isConnected) { record.open = true; draw(record); } }, delay);
  }

  function attach(source) {
    let record = bySource.get(source);
    if (record && record.host.isConnected) { draw(record); return; }
    if (record) dispose(record);
    const host = document.createElement('span');
    host.className = 'ar-material-ripple-host';
    host.setAttribute('aria-hidden', 'true');
    source.append(host);
    record = { source, host, reactRoot: createRoot(host), ripple: null, open: false, timer: null, signature: '', tooltipId: 'ar-material-tooltip-' + (++sequence), listeners: [] };
    records.add(record); bySource.set(source, record);
    const listen = (type, callback) => { source.addEventListener(type, callback); record.listeners.push([type, callback]); };
    listen('pointerdown', event => { if (!source.disabled && event.button === 0 && !reduced.matches) record.ripple?.start(event); });
    listen('pointerup', event => record.ripple?.stop(event));
    listen('pointercancel', event => { record.ripple?.stop(event); hide(record); });
    listen('pointerleave', event => { record.ripple?.stop(event); hide(record); });
    listen('pointerenter', event => { if (event.pointerType !== 'touch') show(record, 500); });
    listen('keydown', event => { if (!source.disabled && !event.repeat && ['Enter', ' '].includes(event.key) && !reduced.matches) record.ripple?.start(event, { center: true }); });
    listen('keyup', event => { if (['Enter', ' '].includes(event.key)) record.ripple?.stop(event); });
    listen('focus', () => { if (source.matches(':focus-visible')) show(record, 0); });
    listen('blur', event => { record.ripple?.stop(event); hide(record); });
    draw(record, true);
  }

  function dispose(record) {
    clearTimeout(record.timer);
    description(record, false);
    for (const [type, callback] of record.listeners) record.source.removeEventListener(type, callback);
    records.delete(record); bySource.delete(record.source);
    queueMicrotask(() => { record.reactRoot.unmount(); record.host.remove(); });
  }

  function sync(root) {
    for (const record of Array.from(records)) if (!record.source.isConnected || !record.host.isConnected) dispose(record);
    for (const source of root.querySelectorAll('button.ar-btn,button.ar-avatar,.ar-nav>button,.ar-group>button,.ar-tabs>button,.ar-pills>button,button.ar-finding-choice,button.ar-publish-choice,button.ar-source-row,button.ar-source-open,button.ar-source-chevron')) attach(source);
  }

  function closeTooltips() { for (const record of records) if (record.open || record.timer) hide(record); }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeTooltips(); });
  return { sync, closeTooltips };
}
