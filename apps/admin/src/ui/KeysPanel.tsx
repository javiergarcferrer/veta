/**
 * BRAND ADMIN — API keys.
 *
 * The list is redacted at the store seam and again by the view model, so there
 * is nothing here to leak. The only credential this component ever holds is the
 * token an ISSUE just returned, in local state, until the panel is closed —
 * which is exactly how long it exists server-side too (a secret is stored as a
 * hash and can never be shown again).
 */
import { useMemo, useState } from 'react';
import { API_KEY_KINDS, SCOPES_BY_KIND, emptyIssueDraft, planIssueKey, resolveKeyList, revealOnce } from '../vm/index.ts';
import type { AdminApiKey, ApiKeyKind, IssueKeyDraft, IssueKeyRequest, IssuedApiKey } from '../vm/index.ts';

export interface KeysPanelProps {
  keys: AdminApiKey[];
  onIssue(request: IssueKeyRequest): Promise<IssuedApiKey>;
  onRevoke(id: string): void;
}

export function KeysPanel({ keys, onIssue, onRevoke }: KeysPanelProps) {
  const [draft, setDraft] = useState<IssueKeyDraft>(emptyIssueDraft());
  const [shown, setShown] = useState<ReturnType<typeof revealOnce> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => resolveKeyList(keys), [keys]);
  const validation = useMemo(() => planIssueKey(draft), [draft]);

  const issue = async () => {
    if (!validation.value) return;
    setError(null);
    try {
      setShown(revealOnce(await onIssue(validation.value)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="panel split">
      <section className="card">
        <h2>API keys</h2>
        <p className="msg muted">{list.active} active · {list.revoked} revoked</p>
        <table>
          <thead><tr><th>Key</th><th>Scopes</th><th>Origins</th><th /></tr></thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.key.id}>
                <td>
                  <code>{row.key.prefix}</code>
                  <div className="msg muted">{row.key.kind}</div>
                  <span className={`pill ${row.state === 'active' ? 'good' : ''}`}>{row.state}</span>
                </td>
                <td>{row.scopeLabel}</td>
                <td>
                  {row.originLabel}
                  {row.openOrigins ? <div className="msg warn">accepted from any site</div> : null}
                </td>
                <td>
                  {row.state === 'active' ? (
                    <button type="button" className="action" onClick={() => onRevoke(row.key.id)}>Revoke</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Issue a key</h2>
        <label>
          Kind
          <select
            value={draft.kind}
            onChange={(e) => setDraft(emptyIssueDraft(e.target.value as ApiKeyKind))}
          >
            {API_KEY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <div>
          <h3>Scopes</h3>
          {SCOPES_BY_KIND[draft.kind].map((scope) => (
            <label className="row" key={scope}>
              <input
                type="checkbox"
                checked={draft.scopes.includes(scope)}
                onChange={(e) => setDraft({
                  ...draft,
                  scopes: e.target.checked
                    ? [...draft.scopes, scope]
                    : draft.scopes.filter((s) => s !== scope),
                })}
              />
              {scope}
            </label>
          ))}
        </div>
        <label>
          Allowed origins — one per line
          <textarea value={draft.origins} onChange={(e) => setDraft({ ...draft, origins: e.target.value })} />
        </label>

        {Object.entries(validation.errors).map(([field, message]) => (
          <p key={field} className="msg error">{message}</p>
        ))}
        {validation.warnings.map((warning) => <p key={warning} className="msg warn">{warning}</p>)}
        {error ? <p className="msg error">{error}</p> : null}

        <button type="button" className="action primary" disabled={!validation.ok} onClick={() => void issue()}>
          Issue
        </button>

        {shown ? (
          <div className="card">
            <h3>{shown.notice}</h3>
            <div className="token">{shown.token}</div>
            <button type="button" className="action" onClick={() => setShown(null)}>Done</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
