/**
 * RULE FEEDBACK — the collection's constraints, as sentences.
 *
 * The engine REPORTS; this panel is where the report becomes something a
 * visitor can act on. Two presentation rules matter:
 *
 *   • an ERROR is what blocks the quote CTA and says so plainly; a WARNING is
 *     advice and never blocks. Rendering both as identical red would train
 *     people to ignore the ones that matter;
 *   • a violation names its PIECES, so hovering a message highlights them on
 *     the plan. "This doesn't work" without pointing at what is the reason
 *     people abandon a configurator.
 *
 * Nothing renders at all when the design is clean and no rules exist — a brand
 * without constraints must not see an empty "everything is fine" box.
 */

import { t, type Locale } from '@veta/i18n';
import type { RulesFeedback } from '../vm/rules.ts';
import { feedbackHeadline } from '../vm/rules.ts';

export interface RulesPanelProps {
  feedback: RulesFeedback;
  locale: Locale;
  onHighlight?: (uids: string[]) => void;
}

export default function RulesPanel({ feedback, locale, onHighlight }: RulesPanelProps) {
  if (!feedback.messages.length) return null;

  return (
    <section
      className={`rules${feedback.canSubmit ? '' : ' rules--blocking'}`}
      aria-live="polite"
      aria-label={t(locale, 'rules.title')}
    >
      <h2 className="rules__title">{feedbackHeadline(feedback, locale)}</h2>
      <ul className="rules__list">
        {feedback.messages.map((message) => (
          <li
            key={`${message.ruleId}:${message.messageKey}:${message.pieces.join(',')}`}
            className={`rules__item rules__item--${message.severity}`}
            onMouseEnter={() => onHighlight?.(message.pieces)}
            onMouseLeave={() => onHighlight?.([])}
          >
            <span className="rules__badge">
              {t(locale, message.severity === 'error' ? 'rules.severity.error' : 'rules.severity.warning')}
            </span>
            <span className="rules__text">{message.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
