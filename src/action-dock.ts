import { reducedMotion, springEasing, type Spring } from './motion';

/* The floating action dock (`#action-dock`): the workspace header's actions as one vertical glass
 * pill at the conversation's right edge (a row in the header on narrow windows, the board and the
 * GitHub view). Like the tool trace it is an exception to "PandaCode is instant": every motion is
 * the Web Animations API or @keyframes (never transitions) and is skipped under reduced motion,
 * when the CSS end state simply applies. Other modules keep owning the buttons: they toggle
 * `hidden`, `active` and `title`, and the observer here animates whatever changed. */

const BOUNCE: Spring = { damping: 0.62, response: 0.34 };
const SETTLE: Spring = { damping: 0.86, response: 0.26 };
const curves = new Map<Spring, { easing: string; duration: number }>();
const curve = (spring: Spring) => {
  let found = curves.get(spring);
  if (!found) { found = springEasing(spring) ?? { easing: 'cubic-bezier(.34,1.4,.64,1)', duration: 380 }; curves.set(spring, found); }
  return found;
};
const still = (): boolean => document.hidden || reducedMotion();
const running = new WeakMap<Element, Map<string, Animation>>();
function track(element: Element, animation: Animation, pseudo = ''): Animation {
  const map = running.get(element) ?? new Map<string, Animation>();
  map.set(pseudo, animation); running.set(element, map);
  return animation;
}

/** Animates `element` (or one of its pseudo-elements) from what is on screen now to the state
 * `change()` leaves in CSS. Reads before the change, so an interrupted motion continues smoothly. */
function morph(targets: [Element, string?][], props: string[], change: () => void, spring = BOUNCE): void {
  const before = targets.map(([element, pseudo]) => {
    const style = getComputedStyle(element, pseudo ?? null);
    return Object.fromEntries(props.map(prop => [prop, style.getPropertyValue(prop)]));
  });
  for (const [element, pseudo] of targets) running.get(element)?.get(pseudo ?? '')?.cancel();
  change();
  if (still()) return;
  const { easing, duration } = curve(spring);
  targets.forEach(([element, pseudo], index) => {
    if (typeof element.animate !== 'function') return;
    track(element, element.animate([{ ...before[index], offset: 0 }], { duration, easing, pseudoElement: pseudo }), pseudo);
  });
}

const buttons = (dock: HTMLElement) => [...dock.querySelectorAll<HTMLButtonElement>('button')];
/** Items you can reach: shown (not hidden or display:none by a stylesheet) and not leaving. */
export const dockItems = (dock: HTMLElement): HTMLButtonElement[] =>
  buttons(dock).filter(item => !item.hidden && !item.hasAttribute('data-leaving') && item.getClientRects().length > 0);
const vertical = (dock: HTMLElement) => getComputedStyle(dock).flexDirection.startsWith('column');
const labelOf = (item: HTMLElement) => item.dataset.dockTip || item.getAttribute('aria-label') || item.textContent?.trim() || '';

/** One Tab stop: the last focused item, else the first. */
function rove(dock: HTMLElement, focus?: HTMLElement): void {
  const items = dockItems(dock);
  const current = focus && items.includes(focus as HTMLButtonElement) ? focus : items.find(item => item.tabIndex === 0) ?? items[0];
  for (const item of buttons(dock)) item.tabIndex = item === current ? 0 : -1;
  dock.setAttribute('aria-orientation', vertical(dock) ? 'vertical' : 'horizontal');
}

/** The dock's own label bubble: on the left of a vertical dock, below a row. */
function tooltip(dock: HTMLElement) {
  const tip = document.createElement('div');
  tip.className = 'action-dock-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  dock.append(tip);
  let anchor: HTMLElement | undefined, leave: Animation | undefined;
  const show = (item: HTMLElement) => {
    const text = labelOf(item);
    if (!text) return;
    const wasShown = !tip.hidden && !leave;
    leave?.cancel(); leave = undefined;
    const previous = wasShown ? { x: tip.offsetLeft, y: tip.offsetTop } : undefined;
    anchor = item; tip.textContent = text; tip.hidden = false;
    const row = !vertical(dock);
    tip.dataset.side = row ? 'below' : 'left';
    const box = item.getBoundingClientRect(), host = dock.getBoundingClientRect();
    if (row) { tip.style.top = `${Math.round(box.bottom - host.top + 8)}px`; tip.style.left = `${Math.round(box.left - host.left + box.width / 2 - tip.offsetWidth / 2)}px`; }
    else { tip.style.top = `${Math.round(box.top - host.top + box.height / 2 - tip.offsetHeight / 2)}px`; tip.style.left = `${Math.round(-tip.offsetWidth - 10)}px`; }
    if (still()) return;
    const { easing, duration } = curve(previous ? SETTLE : BOUNCE);
    // Moving between items slides the bubble; a fresh one pops out of the dock.
    const from = previous
      ? { translate: `${previous.x - tip.offsetLeft}px ${previous.y - tip.offsetTop}px`, offset: 0 }
      : { opacity: 0, scale: 0.86, translate: row ? '0 -4px' : '6px 0', offset: 0 };
    tip.animate([from], { duration, easing });
  };
  const hide = () => {
    if (tip.hidden || leave) return;
    anchor = undefined;
    if (still()) { tip.hidden = true; return; }
    leave = tip.animate([{ opacity: 0, scale: 0.94 }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
    leave.onfinish = () => { tip.hidden = true; leave?.cancel(); leave = undefined; };
  };
  return { show, hide, get anchor() { return anchor; } };
}

function hover(item: HTMLElement, on: boolean): void {
  if (item.hasAttribute('data-hover') === on) return;
  const icon = item.querySelector('.icon');
  morph([[item, '::after'], ...(icon ? [[icon] as [Element]] : [])], ['opacity', 'scale', 'translate'], () => item.toggleAttribute('data-hover', on), on ? BOUNCE : SETTLE);
}
function press(item: HTMLElement, on: boolean): void {
  if (item.hasAttribute('data-press') === on) return;
  const icon = item.querySelector('.icon');
  morph([[item], ...(icon ? [[icon] as [Element]] : [])], ['scale'], () => item.toggleAttribute('data-press', on), on ? SETTLE : BOUNCE);
}

/** Springs an item in when its `hidden` lifts, and out (collapsing its slot) when it is set. */
function appear(item: HTMLButtonElement): void {
  running.get(item)?.get('')?.cancel();
  item.removeAttribute('data-leaving'); item.removeAttribute('aria-hidden'); item.inert = false;
  if (still()) return;
  const { easing, duration } = curve(BOUNCE);
  track(item, item.animate([{ opacity: 0, scale: 0.4, height: '0px', marginBlock: '-2px', offset: 0 }], { duration, easing }));
}
function disappear(item: HTMLButtonElement): void {
  if (still() || typeof item.animate !== 'function') return;
  running.get(item)?.get('')?.cancel();
  item.setAttribute('data-leaving', ''); item.setAttribute('aria-hidden', 'true'); item.inert = true;
  const { duration } = curve(SETTLE);
  const animation = track(item, item.animate([{ opacity: 0, scale: 0.4, height: '0px', marginBlock: '-2px' }], { duration: duration * 0.7, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }));
  animation.onfinish = () => { item.removeAttribute('data-leaving'); item.removeAttribute('aria-hidden'); item.inert = false; animation.cancel(); };
}

/** Plays the dock's entrance: the pill settles in and its items follow one by one. */
export function enterDock(dock: HTMLElement): void {
  if (still() || typeof dock.animate !== 'function') return;
  const row = !vertical(dock);
  const { easing, duration } = curve(BOUNCE);
  if (!row) dock.animate([{ opacity: 0, scale: 0.92, translate: '14px 0', offset: 0 }], { duration, easing });
  dockItems(dock).forEach((item, index) => {
    item.animate([{ opacity: 0, scale: 0.5, translate: row ? '0 -6px' : '10px 0', offset: 0 }], { duration, easing, delay: 60 + index * 34, fill: 'backwards' });
  });
}

export function mountActionDock(dock: HTMLElement): void {
  const tip = tooltip(dock);
  const takeTitle = (item: HTMLElement) => { if (item.title) { item.dataset.dockTip = item.title; item.removeAttribute('title'); } };
  for (const item of buttons(dock)) takeTitle(item);
  new MutationObserver(records => {
    let structure = false;
    for (const record of records) {
      if (record.type === 'childList') { structure = true; for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches('button')) takeTitle(node); continue; }
      const item = record.target as HTMLElement;
      if (!(item instanceof HTMLButtonElement)) continue;
      if (record.attributeName === 'title') { takeTitle(item); continue; }
      if (record.attributeName === 'hidden') {
        const was = record.oldValue !== null;
        if (was && !item.hidden) appear(item); else if (!was && item.hidden) { disappear(item); if (tip.anchor === item) tip.hide(); }
        structure = true;
      } else if (record.attributeName === 'class') {
        const was = ` ${record.oldValue ?? ''} `.includes(' active '), now = item.classList.contains('active');
        // The fill grows in by @keyframes; leaving, the pseudo-element fades out from full.
        if (was && !now && !still() && typeof item.animate === 'function') item.animate([{ opacity: 1, scale: 1, offset: 0 }], { duration: 180, easing: 'ease-out', pseudoElement: '::before' });
      }
    }
    if (structure) rove(dock);
  }).observe(dock, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'title'], attributeOldValue: true });

  let keyboard = false;
  document.addEventListener('keydown', () => { keyboard = true; }, true);
  document.addEventListener('pointerdown', () => { keyboard = false; }, true);
  const itemOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>('#action-dock button') : null;
  dock.addEventListener('pointerover', event => {
    const item = itemOf(event.target); if (!item) return;
    for (const other of buttons(dock)) if (other !== item) { hover(other, false); press(other, false); }
    hover(item, true); tip.show(item);
  });
  dock.addEventListener('pointerleave', () => { for (const item of buttons(dock)) { hover(item, false); press(item, false); } if (!dock.contains(document.activeElement) || !keyboard) tip.hide(); });
  dock.addEventListener('pointerdown', event => { const item = itemOf(event.target); if (item && event.button === 0) press(item, true); tip.hide(); });
  for (const type of ['pointerup', 'pointercancel']) dock.addEventListener(type, event => { const item = itemOf(event.target); if (item) press(item, false); });
  dock.addEventListener('focusin', event => { const item = itemOf(event.target); if (!item) return; rove(dock, item); if (keyboard) tip.show(item); });
  dock.addEventListener('focusout', event => { if (!dock.contains(event.relatedTarget as Node | null)) tip.hide(); });
  dock.addEventListener('keydown', event => {
    if (event.key === 'Escape' && tip.anchor) { tip.hide(); return; }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const items = dockItems(dock), at = items.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const steps: Record<string, number> = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const next = items[(steps[event.key] + items.length) % items.length];
    rove(dock, next); next.focus();
  });
  rove(dock);
  requestAnimationFrame(() => { rove(dock); enterDock(dock); });
}
