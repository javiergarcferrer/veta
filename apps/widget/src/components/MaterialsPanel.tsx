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
 */

import { useMemo, useState } from 'react';
import { t, type Locale } from '@veta/i18n';
import type { MaterialColorOption, MaterialFamily } from '../vm/catalog.ts';
import { pickFromColor, resolveMaterialPicker } from '../vm/materials.ts';

export interface MaterialsPanelProps {
  families: MaterialFamily[];
  locale: Locale;
  /** The uid being dressed, or null for "the whole design". */
  targetUid: string | null;
  activeCode: string;
  onPick: (uid: string | null, pick: ReturnType<typeof pickFromColor>) => void;
  onClear: (uid: string | null) => void;
}

const swatchStyle = (color: MaterialColorOption | null): { background: string } => ({
  background: color?.rgb || '#d9d4cc',
});

export default function MaterialsPanel({ families, locale, targetUid, activeCode, onPick, onClear }: MaterialsPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [openFamilyId, setOpenFamilyId] = useState<string | null>(null);

  const view = useMemo(
    () => resolveMaterialPicker(families, { search, category, openFamilyId, locale }),
    [families, search, category, openFamilyId, locale],
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
