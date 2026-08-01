/**
 * THE FIDELITY PANEL — six observations off the widget's own render.
 *
 * Renders `resolveFidelityChecks` and nothing else: every level, every sentence
 * and the verdict are the VM's, so what the dealer reads here is what the build
 * actually produced. See `vm/fidelity.ts` for why that distinction is the whole
 * feature.
 */
import type { FidelityCheck, FidelityLevel } from '../vm/fidelity.ts';

const VERDICT: Record<FidelityLevel, string> = {
  ok: 'Renders as authored',
  warn: 'Ships, with gaps',
  bad: 'Broken for the client',
  idle: 'Measuring…',
};

export function FidelityPanel({ checks, verdict }: { checks: readonly FidelityCheck[]; verdict: FidelityLevel }) {
  return (
    <div className="card">
      <h3>Fidelity · <span className={`level-${verdict}`}>{VERDICT[verdict]}</span></h3>
      <ul className="list">
        {checks.map((c) => (
          <li key={c.key} className="check">
            <span className={`level-${c.level}`} aria-hidden>●</span>
            <span className="label">{c.label}</span>
            <span className="detail">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
