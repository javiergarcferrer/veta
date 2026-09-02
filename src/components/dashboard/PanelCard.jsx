import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * One section of EL PANEL: the app's own `.card` + `.card-header` shell with an
 * icon (or a brand's own mark), a title, an optional one-line subtitle and an
 * optional "go fix it" link
 * on the right.
 *
 * Presentational only — it derives nothing and formats nothing. Every string and
 * every href it renders was resolved by `resolveAdminDashboard` and mapped to a
 * route by the page.
 */
export default function PanelCard({
  icon: Icon, mark, title, subtitle, to, actionLabel = 'Abrir', children, bodyClass = 'p-5',
}) {
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-2">
            {/* A brand's own mark replaces the generic icon when one is given. */}
            {mark || (Icon && <Icon size={15} className="text-ink-400 shrink-0" aria-hidden />)}
            <span className="truncate">{title}</span>
          </h2>
          {subtitle && <p className="text-micro text-ink-500 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {to && (
          <Link to={to} className="card-header-action shrink-0 whitespace-nowrap">
            {actionLabel} <ArrowRight size={12} aria-hidden />
          </Link>
        )}
      </div>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}
