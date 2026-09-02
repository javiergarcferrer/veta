import { Link } from 'react-router-dom';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import Notice from '../primitives/Notice.jsx';

/**
 * ONE LINE OF THE READINESS LEDGER: how many pieces fail this check, which ones,
 * why it matters, and the link to where it is fixed.
 *
 * Three states, and the middle one is the point:
 *   • ok       — nobody fails it. Rendered dim with a tick; the ledger still
 *                lists it, because "nothing blocks this" is the answer the
 *                screen exists to give.
 *   • pending  — the join behind it has not landed. A SPINNER, never a 0: a
 *                confident zero on an unanswered question is a lie.
 *   • n > 0    — the count, the first few names, and the way out.
 *
 * Presentational: `count`, `examples`, `detail` and `tone` all come straight off
 * `resolveAdminDashboard`.
 */

const TONE = {
  bad: { count: 'text-rose-700 dark:text-rose-400', dot: 'bg-rose-500' },
  warn: { count: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  info: { count: 'text-ink-700', dot: 'bg-ink-300' },
  good: { count: 'text-ink-400', dot: 'bg-emerald-500' },
  neutral: { count: 'text-ink-400', dot: 'bg-ink-300' },
};

export default function CheckRow({ row, to }) {
  const tone = TONE[row.tone] || TONE.neutral;
  const quiet = row.ok || row.pending;

  return (
    <li className={`flex items-start gap-3 py-2.5 ${quiet ? 'opacity-70' : ''}`}>
      <span className="w-8 shrink-0 text-right pt-0.5">
        {row.pending ? (
          <Loader2 size={13} className="inline animate-spin text-ink-400" aria-hidden />
        ) : row.ok ? (
          <Check size={14} className="inline text-emerald-600 dark:text-emerald-400" aria-hidden />
        ) : (
          <span className={`text-base font-semibold tabular-nums ${tone.count}`}>{row.count}</span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {!quiet && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden />}
          <span className={`text-sm ${quiet ? 'text-ink-500' : 'text-ink-900 font-medium'}`}>
            {row.label}
          </span>
          {row.pending && <span className="text-micro text-ink-500">comprobando…</span>}
        </div>

        {!row.ok && <p className="text-micro text-ink-500 mt-0.5 leading-snug">{row.detail}</p>}

        {row.examples?.length > 0 && (
          <p className="text-micro text-ink-500 mt-1 truncate" title={row.examples.join(' · ')}>
            {row.examples.join(' · ')}
            {row.more > 0 && ` · +${row.more}`}
          </p>
        )}
      </div>

      {!quiet && to && (
        <Link
          to={to}
          className="chip-action shrink-0 self-center whitespace-nowrap"
          aria-label={`Resolver: ${row.label}`}
        >
          Resolver <ArrowRight size={11} aria-hidden />
        </Link>
      )}
    </li>
  );
}

/** The «algo está mal» banner a card puts above its rows. Same tone tokens. */
export function IssueNote({ children, to, actionLabel = 'Arreglar' }) {
  return (
    <Notice
      tone="warn"
      dense
      action={to && (
        <Link to={to} className="shrink-0 underline underline-offset-2 hover:no-underline whitespace-nowrap">
          {actionLabel}
        </Link>
      )}
    >
      {children}
    </Notice>
  );
}
