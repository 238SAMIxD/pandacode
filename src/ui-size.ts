import './ui-size.css';
import { commandKey } from './platform';

const preferenceKey = 'pandacode.uiScale';
const minimum = .8, maximum = 1.6, step = .1;
let scale = 1;
try {
  const saved = Number(localStorage.getItem(preferenceKey));
  if (Number.isFinite(saved) && saved >= minimum && saved <= maximum) scale = Math.round(saved * 10) / 10;
} catch { /* Text sizing remains available without storage. */ }
document.documentElement.style.setProperty('--ui-scale', String(scale));

export function uiScale(): number { return scale; }

export function setUiScale(value: number): void {
  if (!Number.isFinite(value)) return;
  const next = Math.min(maximum, Math.max(minimum, Math.round(value * 10) / 10));
  if (next === scale) return;
  scale = next;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  try { localStorage.setItem(preferenceKey, String(scale)); } catch { /* Keep the size for this session. */ }
  document.querySelectorAll<HTMLOutputElement>('[data-ui-size-value]').forEach(output => { output.value = `${Math.round(scale * 100)}%`; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="ui-size-decrease"]').forEach(button => { button.disabled = scale === minimum; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="ui-size-increase"]').forEach(button => { button.disabled = scale === maximum; });
  window.dispatchEvent(new Event('pandacode-ui-scale-change'));
  // Existing floating menus and browser bounds respond without remounting their DOM.
  window.dispatchEvent(new Event('resize'));
}

export function changeUiScale(direction: -1 | 1): void { setUiScale(scale + direction * step); }

export function uiSizeControls(): string {
  const modifier = commandKey;
  return `<div class="setting-row text-size-setting"><div><strong>Text size</strong><small>${modifier} + / − to resize · ${modifier} 0 to reset</small></div><div class="text-size-controls" role="group" aria-label="Text size"><button type="button" data-action="ui-size-decrease" aria-label="Decrease text size" title="Decrease text size (${modifier} −)" ${scale === minimum ? 'disabled' : ''}>A−</button><output data-ui-size-value aria-label="Current text size" aria-live="polite">${Math.round(scale * 100)}%</output><button type="button" data-action="ui-size-increase" aria-label="Increase text size" title="Increase text size (${modifier} +)" ${scale === maximum ? 'disabled' : ''}>A+</button><button type="button" class="text-size-reset" data-action="ui-size-reset" aria-label="Reset text size" title="Reset text size (${modifier} 0)">Reset</button></div></div>`;
}

export function initializeUiSizing(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.defaultPrevented) return;
    const direction = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : 0;
    if (!direction && event.key !== '0') return;
    event.preventDefault();
    // Capture before terminal/menu handlers so the shortcut never becomes agent input.
    event.stopPropagation();
    if (direction) changeUiScale(direction);
    else setUiScale(1);
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
