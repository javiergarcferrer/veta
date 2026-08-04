import { Link } from 'react-router-dom';

/**
 * A KPI tile on EL PANEL — the app's `.stat-card` / `.stat-value` / `.icon-tile`
 * primitives, nothing new.
 *
 * The whole tile is the link: every number on this screen goes to the page that
 * changes it. `tone` is a TOKEN resolved by the VM (never a colour decision made
 * here); it only picks which `.tint-*` plate the icon sits on and whether the
 * hint reads as a warning.
 */

const TINT = {
  good: 'tint-emerald',
  warn: 'tint-brand',
  bad: 'tint-rose',
  info: 'tint-sky',
  neutral: 'tint-ink',
};

const HINT = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-rose-700 dark:text-rose-400',
  info: 'text-ink-500',
  neutral: 'text-ink-500',
};

export default function StatTile({ icon: Icon, label, value, hint, tone = 'neutral', to }) {
  const body = (
    <div className="p-4 flex items-start gap-3">
      {Icon && (
        <span className={`icon-tile ${TINT[tone] || TINT.neutral}`} aria-hidden>
          <Icon size={15} />
        </span>
      )}
      <div className="min-w-0">
        <div className="stat-value">{value}</div>
        <div className="eyebrow mt-1.5 truncate" title={label}>{label}</div>
        {hint && <p className={`text-[11px] mt-1 leading-snug ${HINT[tone] || HINT.neutral}`}>{hint}</p>}
      </div>
    </div>
  );
  if (!to) return <div className="stat-card">{body}</div>;
  return (
    <Link
      to={to}
      className="stat-card block hover:-translate-y-0.5 hover:border-brand-200 transition-[box-shadow,transform,border-color] duration-200"
    >
      {body}
    </Link>
  );
}
