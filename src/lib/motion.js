// Motion preference — the ONE place JS-driven animation reads the OS "reduce
// motion" setting, mirroring the CSS layer (index.css collapses every keyframe
// animation under the same media query). Any rAF tween (camera glides, count-ups,
// scene entrances) checks this and jumps straight to its end state instead.
export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
}
