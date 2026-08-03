/**
 * THE MATERIALS PICKER — two levels of tiles (family → colour).
 *
 * All the arranging is `vm/materials`' job (`resolveMaterialPicker`): this file
 * holds the query in state, renders tiles, and reports the pick. The count line
 * under each tile comes back from the VM already pluralized and localized,
 * because "1 colores" is the kind of detail a translator flags and a component
 * quietly gets wrong.
 *
 * Applying to ALL pieces is a first-class action, not a shortcut: choosing one
 * fabric for the whole design is the single most-used control in this UI, and it
 * is also the cheaper way to buy the piece (one fabric bills as one complete
 * element), so the button is on the panel rather than buried.
 *
 * The PART rows sit above the wall (see `vm/parts`): the two kinds a piece is
 * made of, each under its own eyebrow — «Componentes» wear cloth, «Estructura»
 * wears an acabado and always comes last — and a part with no pick of its own
 * whispers that it rides the piece's cloth rather than showing a fabric name
 * that reads as a choice nobody made.
 *
 * THE RAIL IS THE WORKSPACE: a pick does NOT close it or drop its target (see
 * `vm/chrome`). Dressing a cushion is not a request to stop looking at cushions.
 */

import { useMemo, useState } from 'react';
import { t, type Locale } from '@veta/i18n';
import type { PriceFamily } from '@veta/catalog';
import type { MaterialColorOption, MaterialFamily } from '../vm/catalog.ts';
import { pickFromColor, resolveMaterialPicker } from '../vm/materials.ts';
import type { PartsPanelView } from '../vm/parts.ts';

export interface MaterialsPanelProps {
  families: MaterialFamily[];
  locale: Locale;
  /** The uid being dressed, or null for "the whole design". */
  targetUid: string | null;
  activeCode: string;
  /** The ladder(s) the pick will be priced against (`pickLaddersFor`) — the wall
   *  shows only what they can sell, so a tile can never store a pick the price
   *  gate then refuses. */
  ladders?: readonly (PriceFamily | null | undefined)[] | null;
  /** The selected piece's parts, or null when nothing is selected. */
  parts?: PartsPanelView | null;
  /** The part role the wall is currently dressing ('' = the whole piece). */
  partRole?: string | null;
  onPickPart?: (role: string | null) => void;
  onClearPart?: (role: string) => void;
  onPick: (uid: string | null, pick: ReturnType<typeof pickFromColor>) => void;
  onClear: (uid: string | null) => void;
}

const swatchStyle = (color: MaterialColorOption | null): { background: string } => ({
  background: color?.rgb || '#d9d4cc',
});

export default function MaterialsPanel({
  families, locale, targetUid, activeCode, ladders, parts, partRole, onPickPart, onClearPart, onPick, onClear,
}: MaterialsPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [openFamilyId, setOpenFamilyId] = useState<string | null>(null);

  const view = useMemo(
    () => resolveMaterialPicker(families, { search, category, openFamilyId, locale, ladders }),
    [families, search, category, openFamilyId, locale, ladders],
  );

  if (!families.length) {
    return (
      <section className="panel" aria-label={t(locale, 'fabric.pickerTitle')}>
        <p className="panel__empty">{t(locale, 'fabric.noOptions')}</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-label={t(locale, 'fabric.pickerTitle')}>
      <header className="panel__head">
        <h2 className="panel__title">
          {view.openFamily ? view.openFamily.name : t(locale, 'fabric.paneChoose')}
        </h2>
        {view.openFamily ? (
          <button type="button" className="btn btn--quiet" onClick={() => setOpenFamilyId(null)}>
            {t(locale, 'fabric.paneBack')}
          </button>
        ) : null}
      </header>

      {parts && !parts.empty ? (
        <div className="parts">
          {/* The whole piece first — one cloth everywhere is the default, and
              the cheaper way to buy it. */}
          <button
            type="button"
            className={`chip${partRole ? '' : ' is-on'}`}
            onClick={() => onPickPart?.(null)}
          >
            {t(locale, 'parts.wholePiece')}
          </button>

          {parts.components.length ? (
            <>
              <span className="parts__eyebrow">{parts.componentsLabel}</span>
              <ul className="parts__list">
                {parts.components.map((row) => (
                  <li key={row.role} className="parts__row">
                    <button
                      type="button"
                      className={`parts__pick${partRole === row.role ? ' is-on' : ''}`}
                      aria-label={t(locale, 'chip.pickFabricFor', { name: row.label })}
                      onClick={() => onPickPart?.(row.role)}
                    >
                      <span className="parts__name">{row.label}</span>
                      <span className="parts__wearing">{row.wearing}</span>
                      {/* THE WHISPER: inheritance, declared where it is seen. A
                          fabric name alone is indistinguishable from a part that
                          chose exactly that cloth. */}
                      {row.note ? <span className="parts__note">{row.note}</span> : null}
                    </button>
                    {row.inherited ? null : (
                      <button
                        type="button"
                        className="btn btn--quiet"
                        title={t(locale, 'parts.useSamePiece')}
                        aria-label={t(locale, 'parts.useSamePiece')}
                        onClick={() => onClearPart?.(row.role)}
                      >
                        ↩
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {/* ESTRUCTURA — its own kind, its own eyebrow, and ALWAYS last: metal
              wears an acabado, never cloth, so it can never be dressed from the
              wall above. */}
          {parts.structures.length ? (
            <>
              <span className="parts__eyebrow">{parts.structureLabel}</span>
              <ul className="parts__list">
                {parts.structures.map((row) => (
                  <li key={row.groupKey} className="parts__row">
                    <span className="parts__pick">
                      <span className="parts__name">{row.label}</span>
                      <span className="parts__wearing">{row.wearing}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {view.openFamily ? null : (
        <div className="panel__filters">
          <input
            className="input"
            type="search"
            value={search}
            placeholder={t(locale, 'fabric.paneSearch')}
            aria-label={t(locale, 'fabric.paneFilter')}
            onChange={(e) => setSearch(e.target.value)}
          />
          {view.categories.length > 1 ? (
            <div className="chips" role="group" aria-label={t(locale, 'fabric.paneAll')}>
              <button
                type="button"
                className={`chip${category ? '' : ' is-on'}`}
                onClick={() => setCategory('')}
              >
                {t(locale, 'fabric.paneAll')}
              </button>
              {view.categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip${category === c ? ' is-on' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {view.openFamily ? (
        <ul className="tiles tiles--colors">
          {view.colors.map((color) => (
            <li key={color.code}>
              <button
                type="button"
                className={`tile${activeCode === color.code ? ' is-on' : ''}`}
                onClick={() => onPick(targetUid, pickFromColor(color))}
              >
                <span className="tile__swatch" style={swatchStyle(color)} aria-hidden />
                <span className="tile__name">{color.name}</span>
                <span className="tile__meta">{color.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="tiles">
          {view.families.map((tile) => (
            <li key={tile.id}>
              <button type="button" className="tile" onClick={() => setOpenFamilyId(tile.id)}>
                <span className="tile__swatch" style={swatchStyle(tile.swatch)} aria-hidden />
                <span className="tile__name">{tile.name}</span>
                <span className="tile__meta">{view.countLabel(tile)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {view.empty ? <p className="panel__empty">{t(locale, 'fabric.paneNoResults')}</p> : null}

      <footer className="panel__foot">
        <p className="panel__note">
          {targetUid ? t(locale, 'parts.byParts') : t(locale, 'parts.oneElement')}
        </p>
        <button type="button" className="btn btn--quiet" onClick={() => onClear(targetUid)}>
          {t(locale, 'fabric.remove')}
        </button>
      </footer>
    </section>
  );
}
