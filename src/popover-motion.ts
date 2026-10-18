import { reducedMotion, springKeyframes } from './motion';

const transitions = new WeakMap<HTMLElement, () => void>();
const departures = new Map<HTMLElement, () => void>();

function transition(panel: HTMLElement, frames: Keyframe[], duration: number, exiting: boolean): void {
  let animation: Animation;
  try {
    animation = panel.animate(frames, {
      duration,
      easing: exiting ? 'cubic-bezier(.4, 0, .9, .6)' : 'linear',
      // The underlying style remains visible if WebKit suspends animation work.
      fill: 'none',
    });
  } catch {
    if (exiting) panel.remove();
    else panel.dataset.popoverState = 'open';
    return;
  }

  let settled = false;
  let timer = 0;
  function release(): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    transitions.delete(panel);
    departures.delete(panel);
  }
  function finish(): void {
    if (settled) return;
    release();
    if (exiting) panel.remove();
    else panel.dataset.popoverState = 'open';
  }
  function onVisibilityChange(): void { if (document.hidden) finish(); }

  transitions.set(panel, release);
  if (exiting) departures.set(panel, finish);
  animation.onfinish = finish;
  animation.oncancel = finish;
  // Completion callbacks are not reliable in a background native webview.
  timer = window.setTimeout(finish, duration + 60);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/** Call after insertion and positioning. The menu is immediately interactive. */
export function showPopover(panel: HTMLElement, anchor: HTMLElement): void {
  // Fast switching must not leave a stack of fading, detached menus behind.
  for (const [other, finish] of departures) if (other !== panel) finish();
  transitions.get(panel)?.();
  panel.classList.add('floating-menu');
  panel.inert = false;
  panel.removeAttribute('aria-hidden');
  panel.style.pointerEvents = '';
  panel.style.opacity = '1';
  panel.style.transform = 'none';

  const trigger = anchor.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const above = panel.dataset.placement
    ? panel.dataset.placement === 'above'
    : bounds.top + panel.offsetHeight / 2 < trigger.top + trigger.height / 2;
  const originX = Math.max(0, Math.min(panel.offsetWidth, trigger.left + trigger.width / 2 - bounds.left));
  panel.style.transformOrigin = `${originX}px ${above ? '100%' : '0%'}`;
  panel.dataset.placement = above ? 'above' : 'below';
  panel.dataset.popoverState = 'open';
  if (document.hidden || typeof panel.animate !== 'function') return;

  panel.dataset.popoverState = 'entering';
  if (reducedMotion()) { transition(panel, [{ opacity: 0 }, { opacity: 1 }], 90, false); return; }
  // The menu grows out of its trigger as glass. Opacity and blur lead the spring, so
  // the material is fully formed while the panel is still settling into place.
  const backdrop = backdropOf(panel), rise = above ? 6 : -6;
  const { keyframes, duration } = springKeyframes({ response: 0.3 }, progress => {
    const lead = Math.min(1, progress * 1.7);
    return {
      opacity: lead,
      transform: `translateY(${(rise * (1 - progress)).toFixed(2)}px) scale(${(0.94 + 0.06 * progress).toFixed(4)})`,
      ...(backdrop ? { backdropFilter: backdrop(lead), webkitBackdropFilter: backdrop(lead) } : {}),
    };
  });
  transition(panel, keyframes, duration, false);
}

/** Interpolates the panel's blur from clear glass to its settled material. */
function backdropOf(panel: HTMLElement): ((progress: number) => string) | undefined {
  const style = getComputedStyle(panel);
  const target = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
  if (!target || target === 'none' || /url\(|drop-shadow/.test(target)) return undefined;
  const values = (target.match(/-?[\d.]+/g) ?? []).map(Number);
  const identity = (name: string): number => name === 'blur' || name === 'grayscale' || name === 'sepia' || name === 'invert' || name === 'hue-rotate' ? 0 : 1;
  const names = [...target.matchAll(/([a-z-]+)\(/g)].map(match => match[1]);
  return progress => {
    let index = 0;
    return target.replace(/-?[\d.]+/g, () => { const i = index++; const start = identity(names[i] ?? 'blur'); return (start + ((values[i] ?? start) - start) * progress).toFixed(3); });
  };
}

/** Dismisses interaction immediately; removes the visual after its short fade. */
export function hidePopover(panel: HTMLElement): void {
  if (departures.has(panel)) return;
  const presentation = getComputedStyle(panel);
  const opacity = presentation.opacity;
  const transform = presentation.transform;
  transitions.get(panel)?.();
  panel.inert = true;
  panel.setAttribute('aria-hidden', 'true');
  panel.style.pointerEvents = 'none';
  panel.dataset.popoverState = 'closing';
  if (document.hidden || !panel.isConnected || typeof panel.animate !== 'function') {
    panel.remove();
    return;
  }
  const reduced = reducedMotion();
  const backdrop = presentation.backdropFilter || presentation.getPropertyValue('-webkit-backdrop-filter');
  const clear = backdropOf(panel)?.(0);
  const material = !reduced && clear && backdrop && backdrop !== 'none' ? { from: { backdropFilter: backdrop, webkitBackdropFilter: backdrop }, to: { backdropFilter: clear, webkitBackdropFilter: clear } } : { from: {}, to: {} };
  transition(panel, reduced ? [{ opacity }, { opacity: 0 }] : [
    { opacity, transform, ...material.from },
    { opacity: 0, transform: `translateY(${panel.dataset.placement === 'above' ? 4 : -4}px) scale(.965)`, ...material.to },
  ], reduced ? 70 : 120, true);
}
