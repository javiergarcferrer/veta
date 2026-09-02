import { Stat } from '../quant/Figures.jsx';

/**
 * A KPI tile on EL PANEL — a prop ADAPTER over the one figure recipe
 * (`components/quant/Figures.jsx` → `<Stat>`), not a second tile. It used to
 * re-type the tile's shell and headline classes by hand, which is exactly how
 * RosetSoft grew thirteen label-over-a-number components before it had one;
 * the design system's §4 rule ("one recipe per job") is pinned by
 * `tests/designSystem`.
 *
 * The whole tile is the link: every number on this screen goes to the page
 * that changes it. `tone` is a TOKEN resolved by the VM (never a colour
 * decision made here); it picks the icon's `.tint-*` plate and whether the
 * hint reads as a warning — through the measured valence inks, which carry
 * both themes (§6), not raw Tailwind shades that go to ~3:1 in dark mode.
 */

const TINT = {
  good: 'tint-emerald',
  warn: 'tint-brand',
  bad: 'tint-rose',
  info: 'tint-sky',
  neutral: 'tint-ink',
};

const HINT = {
  good: 'text-status-good-ink',
  warn: 'text-status-warning-ink',
  bad: 'text-status-critical-ink',
  info: '',
  neutral: '',
};

export default function StatTile({ icon, label, value, hint, tone = 'neutral', to }) {
  return (
    <Stat
      icon={icon}
      tint={TINT[tone] || TINT.neutral}
      label={label}
      value={value}
      hint={hint ? <span className={HINT[tone] || ''}>{hint}</span> : undefined}
      to={to}
      className="h-full"
    />
  );
}
