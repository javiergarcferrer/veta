/**
 * THE INSPECTOR — five tabs over ONE model, each rendering a `resolve*`.
 *
 * Every tab is a projection plus event handlers; nothing here derives anything.
 * Parts roles come from `detectParts`, the SKU slots from `resolveSkuBinding`,
 * the blast radius from `planFinishCommit`, the gate from
 * `resolvePublishChecks` — the View's only job is to put them on screen and
 * send the dealer's edit back up.
 *
 * Five small components in one file, deliberately: the reference's 3354-line
 * ModelStudio is the debt this app exists not to repeat, and the fix is that the
 * LOGIC left the component — not that each of five 40-line panels gets its own
 * file to import from.
 */
import { useMemo } from 'react';
import { PART_LABELS, PART_ROLES, mergedKeyOf, structureStarterFinish } from '@veta/materials';
import { planFinishCommit, resolveStructureFinish, structureFinishesOf, structureKeysOf } from '../vm/finishes.ts';
import type { PartGroupBox } from '../vm/parts.ts';
import { resolvePublishChecks } from '../vm/publish.ts';
import { resolveSkuBinding } from '../vm/sku.ts';
import type { PartsDraft, StudioModel } from '../vm/types.ts';

export type InspectorTab = 'parts' | 'sku' | 'finishes' | 'plan' | 'publish';
export const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: 'parts', label: 'Parts' },
  { id: 'sku', label: 'SKU' },
  { id: 'finishes', label: 'Finishes' },
  { id: 'plan', label: 'Plan' },
  { id: 'publish', label: 'Publish' },
];

export interface InspectorProps {
  tab: InspectorTab;
  model: StudioModel;
  /** Every model, for the collection-wide fan-out preview. */
  models: readonly StudioModel[];
  draft: PartsDraft;
  /** The groups the last detect measured; empty until one has run. */
  groups: readonly PartGroupBox[];
  busy: string | null;
  error: string | null;
  /** What the write is doing. There is no «Save» button — see vm/save. */
  saveStatus: { show: boolean; level: 'ok' | 'warn' | 'bad'; label: string };
  /** The part the join gesture joins INTO. */
  selectedKey: string | null;
  joinMode: boolean;
  onSelectKey: (key: string | null) => void;
  onToggleJoinMode: () => void;
  onJoin: (target: string, memberKeys: string[]) => void;
  onSeparate: (memberKeys: string[]) => void;
  onSetRole: (groupKey: string, role: string) => void;
  onBindPart: (groupKey: string, role: string, root: string) => void;
  onCount: (role: string, n: number) => void;
  onBindBase: (root: string) => void;
  onSetFinish: (groupKey: string, spec: unknown) => void;
  onPublish: (want: 'draft' | 'published') => void;
}

export function Inspector(props: InspectorProps) {
  const { tab } = props;
  return (
    <div className="inspector">
      <div className="pane">
        {props.error ? <div className="tiny level-bad">{props.error}</div> : null}
        {props.busy ? <div className="tiny muted">{props.busy}…</div> : null}
        {/* THE STATUS STRIP. It used to hold «Save parts» and «Discard» — a
            button the dealer had to find for the one part of this screen that
            did not save itself, while every other control commits as you type.
            It saves itself now, so all that is left to say is whether the write
            is out, what the collection took with it, and what broke. */}
        {props.saveStatus.show
          ? <div role="status" className={`tiny level-${props.saveStatus.level}`}>{props.saveStatus.label}</div>
          : null}
        {tab === 'parts' ? <PartsTab {...props} /> : null}
        {tab === 'sku' ? <SkuTab {...props} /> : null}
        {tab === 'finishes' ? <FinishesTab {...props} /> : null}
        {tab === 'plan' ? <PlanTab {...props} /> : null}
        {tab === 'publish' ? <PublishTab {...props} /> : null}
      </div>
    </div>
  );
}

/* ── Parts ──────────────────────────────────────────────────────────────────*/

function PartsTab({
  draft, groups, selectedKey, joinMode, onSelectKey, onToggleJoinMode, onJoin, onSeparate, onSetRole,
}: InspectorProps) {
  const mats = (draft.mats as Record<string, string>) || {};
  // The stored tagging is the truth; a detect only ever ADDS keys, so the list
  // is the union — a group the dealer tagged before the last detect must not
  // vanish because this session hasn't re-measured the mesh.
  const keys = useMemo(
    () => [...new Set([...groups.map((g) => g.key), ...Object.keys(mats)])].sort(),
    [groups, mats],
  );
  // WHAT THE SELECTED PART IS MADE OF — every key that resolves into it, minus
  // its own. Read as inventory, not as history: a member can be another material
  // the dealer folded in OR a split island of this one's own material, and the
  // list must not care which. That is the whole of separating something you did
  // not group yourself.
  const members = useMemo(
    () => (selectedKey ? keys.filter((k) => k !== selectedKey && mergedKeyOf(draft, k) === selectedKey) : []),
    [keys, selectedKey, draft],
  );
  const others = useMemo(
    () => (selectedKey ? keys.filter((k) => mergedKeyOf(draft, k) !== selectedKey) : []),
    [keys, selectedKey, draft],
  );

  return (
    <>
      <div className="card">
        <h3>Part groups</h3>
        {!keys.length ? <div className="tiny muted">No tagging yet — it runs itself once the mesh is current.</div> : null}
        <ul className="list">
          {keys.map((key) => (
            <li key={key} className={`row${key === selectedKey ? ' on' : ''}`}>
              <button
                type="button"
                className="tiny"
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}
                title={key}
                aria-pressed={key === selectedKey}
                onClick={() => onSelectKey(key === selectedKey ? null : key)}
              >
                {key}
              </button>
              <select value={mats[key] || 'base'} onChange={(e) => onSetRole(key, e.target.value)}>
                {PART_ROLES.map((role) => (
                  <option key={role} value={role}>{PART_LABELS[role] || role}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>

      {/* ── JOIN AND SEPARATE — one control, both directions.
          It HAS to be one control because the dealer cannot see the difference
          it used to depend on. A CAD export hands over MATERIAL groups and the
          studio then splits a material whose meshes are different shapes into
          islands; so "the cushion" and "the frame" can be two materials (a
          merge) or two islands of one material (an un-split), and on screen
          they look identical. Joining wrote `merges`, which does nothing for an
          island's ROLE — so the one case he actually had, a seat cushion tagged
          out of the frame's own material, had no route at all. */}
      {selectedKey ? (
        <div className="card">
          <h3>Join and separate</h3>
          <button
            type="button"
            aria-pressed={joinMode}
            className={joinMode ? 'primary' : ''}
            onClick={onToggleJoinMode}
          >
            {joinMode ? 'Done' : 'Join and separate'}
            <kbd style={{ marginLeft: 6, opacity: 0.6, fontSize: '0.75em' }}>U</kbd>
          </button>
          <div className="tiny muted">
            {joinMode
              ? 'Pick a group below to fold it into this part; pick one of its own to separate it.'
              : 'Everything you fold in becomes this part; anything already its own separates back out.'}
          </div>

          {members.length ? (
            <>
              <ul className="list">
                {members.map((m) => (
                  <li key={m} className="row">
                    <span className="tiny" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m}>{m}</span>
                    <button type="button" onClick={() => onSeparate([m])}>Separate</button>
                  </li>
                ))}
              </ul>
              {members.length > 1 ? (
                <button type="button" onClick={() => onSeparate(members)}>Separate them all</button>
              ) : null}
              <div className="tiny muted">
                Each becomes its own part again, keeping the role it has now. The finish stays with this part.
              </div>
            </>
          ) : null}

          {joinMode && others.length ? (
            <ul className="list">
              {others.map((k) => (
                <li key={k} className="row">
                  <span className="tiny" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={k}>{k}</span>
                  <button type="button" onClick={() => onJoin(selectedKey, [k])}>Join</button>
                </li>
              ))}
            </ul>
          ) : null}

          {!members.length && !others.length ? (
            <div className="tiny muted">A single mesh: nothing to join it to and nothing to separate from it.</div>
          ) : null}
        </div>
      ) : (
        <div className="tiny muted">Pick a part group to join or separate it.</div>
      )}
    </>
  );
}

/* ── SKU ────────────────────────────────────────────────────────────────────*/

function SkuTab({ model, draft, onBindBase, onBindPart, onCount }: InspectorProps) {
  const view = useMemo(() => resolveSkuBinding({ ...model, parts: draft }), [model, draft]);
  return (
    <>
      <div className="card">
        <h3>Base product</h3>
        <div className="row">
          <label htmlFor="base-root">Root</label>
          <input
            id="base-root"
            defaultValue={view.baseRoot || ''}
            placeholder="e.g. 10574010"
            onBlur={(e) => onBindBase(e.target.value.trim())}
          />
        </div>
        <div className="tiny muted">{view.quotable ? 'Quotable.' : 'Unbound — the piece cannot price.'}</div>
      </div>
      <div className="card">
        <h3>Billed part slots</h3>
        <ul className="list">
          {view.slots.map((slot) => (
            <li key={slot.role}>
              <div className="row">
                <label>{slot.label}</label>
                <input
                  defaultValue={slot.root || ''}
                  placeholder={slot.groups.length ? 'part SKU root' : 'no group tagged'}
                  disabled={!slot.groups.length}
                  onBlur={(e) => onBindPart(slot.groups[0] || '', slot.role, e.target.value.trim())}
                />
                <input
                  type="number"
                  min={0}
                  style={{ width: '4rem' }}
                  value={slot.count}
                  disabled={!slot.groups.length}
                  onChange={(e) => onCount(slot.role, Number(e.target.value))}
                />
              </div>
              <div className="tiny muted">{slot.groups.length ? `${slot.groups.length} group(s) · bills ×${slot.count}` : 'free slot'}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/* ── Finishes ───────────────────────────────────────────────────────────────*/

function FinishesTab({ model, models, draft, onSetFinish }: InspectorProps) {
  const groups = useMemo(() => structureKeysOf(draft), [draft]);
  const collectionSpec = useMemo(
    () => structureFinishesOf(models.filter((m) => m.id !== model.id), model.collection),
    [models, model.id, model.collection],
  );
  // The blast radius is the PLAN, counted — the number the dealer reads before
  // committing is exactly the set of rows that will then be written.
  const plan = useMemo(() => planFinishCommit(models, {
    collection: model.collection,
    sourceModelId: model.id,
    before: model.parts?.finishes,
    after: draft.finishes,
    parts: draft,
  }), [models, model, draft]);

  return (
    <>
      <div className="card">
        <h3>Collection reach</h3>
        <div className="tiny">
          {plan.blastRadius === 0
            ? 'Editing this palette changes no other model.'
            : `The next save also rewrites ${plan.blastRadius} other model(s) in "${model.collection || 'no collection'}".`}
          {plan.structureMoved ? ' The structure palette moved (shared by role).' : ''}
        </div>
      </div>
      {!groups.length ? <div className="tiny muted">No structure groups. Tag a part as “Estructura” in Parts first.</div> : null}
      {groups.map((key) => {
        const state = resolveStructureFinish(draft, key, collectionSpec);
        return (
          <div className="card" key={key}>
            <h3>{key}</h3>
            <div className={`tiny level-${state.ready ? 'ok' : 'warn'}`}>
              {state.status === 'ready' ? 'The client is offered this palette.' : null}
              {state.status === 'partial' ? `${state.dropped} typed option(s) are being thrown away.` : null}
              {state.status === 'invalid' ? 'Every typed option is unusable (needs a name and a #rrggbb).' : null}
              {state.status === 'empty' ? 'No palette anywhere — the client is offered nothing.' : null}
              {state.status === 'off' ? 'Not a structure group.' : null}
            </div>
            <ul className="list" style={{ marginTop: 6 }}>
              {(state.effective?.options || []).map((o) => (
                <li key={o.id} className="row tiny">
                  <span className="swatch" style={{ background: o.rgb }} />
                  <span>{o.label}</span>
                  <span className="muted">{o.rgb}</span>
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" onClick={() => onSetFinish(key, structureStarterFinish())} disabled={state.status === 'ready'}>
                Use starter palette
              </button>
              <button type="button" onClick={() => onSetFinish(key, null)} disabled={!state.own}>Clear</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── Plan ───────────────────────────────────────────────────────────────────*/

function PlanTab({ model }: InspectorProps) {
  const plan = model.plan;
  return (
    <>
      <div className="card">
        <h3>Mesh</h3>
        <div className="tiny muted" style={{ overflowWrap: 'anywhere' }}>{model.mesh?.url || 'No mesh.'}</div>
        <div className="tiny muted">
          {model.mesh ? `${model.mesh.upAxis}-up · v${model.mesh.meshVersion ?? '—'} · ${fmtBytes(model.mesh.bytes)}` : null}
        </div>
      </div>
      <div className="card">
        <h3>Plan</h3>
        {plan?.svg
          ? (
            <>
              <div className="tiny muted">{Math.round(plan.widthCm)} × {Math.round(plan.depthCm)} cm</div>
              {/* The plan is our own generated SVG (viewBox = the real cm
                  footprint), produced by @veta/geometry from the mesh — never
                  third-party markup. */}
              <div className="plan" dangerouslySetInnerHTML={{ __html: plan.svg }} />
            </>
          )
          : <div className="tiny muted">No plan derived yet.</div>}
      </div>
    </>
  );
}

const fmtBytes = (n: number | null | undefined): string =>
  (Number.isFinite(Number(n)) ? `${(Number(n) / 1024 / 1024).toFixed(2)} MB` : '—');

/* ── Publish ────────────────────────────────────────────────────────────────*/

function PublishTab({ model, onPublish }: InspectorProps) {
  const checks = useMemo(() => resolvePublishChecks(model), [model]);
  const blocked = checks.filter((c) => c.level === 'blocked');
  return (
    <>
      <div className="card">
        <h3>Completeness</h3>
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
      <div className="row">
        {model.status === 'published'
          ? <button type="button" onClick={() => onPublish('draft')}>Unpublish</button>
          : (
            <button type="button" className="primary" disabled={blocked.length > 0} onClick={() => onPublish('published')}>
              Publish
            </button>
          )}
        <span className="tiny muted">
          {model.status === 'published' ? 'Live.' : blocked.length ? `${blocked.length} check(s) still blocking.` : 'Ready.'}
        </span>
      </div>
    </>
  );
}
