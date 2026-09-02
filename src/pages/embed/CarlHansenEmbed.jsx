import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, RotateCw, SearchX } from 'lucide-react';
import { fetchChModels, fetchChConfiguration } from '../../brands/carl-hansen/client.js';
import { resolveCarlHansenConfigurator } from '../../core/catalog/carlHansenConfigurator.js';
import {
  chBindingPaints, chPublicNotice, resolveChPicker, CH_PICKER_PAGE,
} from '../../core/catalog/index.js';
import ChStage from '../../components/carlhansen/ChStage.jsx';
import { ChPhoto } from '../../components/carlhansen/ChModelGrid.jsx';
import { chCoverImageUrl } from '../../brands/carl-hansen/materialZips.js';
import Notice from '../../components/primitives/Notice.jsx';
import EmptyState from '../../components/EmptyState.jsx';

/**
 * EL CONFIGURADOR DE CARL HANSEN — la segunda instancia, y la primera que no
 * es Togo.
 *
 * ── POR QUÉ NO ES EL MISMO WIDGET ───────────────────────────────────────────
 * `ConfiguratorEmbed` composes GEOMETRY: you place modules on a floor, drag them,
 * rotate them, and the price is the sum of what you placed. That instrument is
 * correct for a modular sofa and wrong for a chair. A Wishbone is ONE chair;
 * what you choose is its wood, its finish and its seat — AXES — and the answer
 * is one composed SKU at one list price. So this brand brings its own
 * instrument (`brands/configurators`), and neither had to be generalised into
 * something bad at both.
 *
 * What they DO share is the kitchen: the same light rig, the same mesh loader,
 * the same swatch sampling (`ChStage` → `sceneBuilder`). A new brand needs its
 * own view and its own projection, never another 3D engine.
 *
 * ── LO QUE MUESTRA, Y LO QUE SE NIEGA A MOSTRAR ─────────────────────────────
 * The whole view is `resolveCarlHansenConfigurator`, a pure projection ported
 * from the dealer back-office because its pricing grammar was MEASURED against
 * the manufacturer's own data rather than inferred. Every money rule comes with
 * it, and the two that show on screen are:
 *
 *   • A price key that resolves to nothing prices NOTHING. The screen says «sin
 *     precio» and means it. Never interpolate, never nearest-match — a null is
 *     recoverable, a plausible wrong number travels into a quote.
 *   • The figure shown is the base PLUS every MANDATORY surcharge. CH24-H43
 *     shares plain CH24's price key and is separated from it only by a
 *     mandatory `Height: LOW` charge; showing the bare base would offer a
 *     $2,450 chair at $2,305.
 *
 * STOCK IS NOT SHOWN AT ALL, and that is not an omission. Carl Hansen is made
 * to order: a zero in Odense means "wait 54 days", not "cannot sell". The lead
 * time is the honest answer to the question the visitor is actually asking.
 *
 * ── UNA MARCA QUE NO ES LA NUESTRA ──────────────────────────────────────────
 * No cost, no margin and no dealer identity reach this widget — it re-serves
 * what carlhansen.com already publishes to anyone. What a dealer charges is a
 * conversation, and the configurator's job is to get the visitor to the right
 * product with the right options, not to quote it.
 *
 * ── LA PORTADA ──────────────────────────────────────────────────────────────
 * The picker is `resolveChPicker` rendered: shelves in the house's editorial
 * order, each a grid of photo cards — cover, name, designer, code. It used to
 * be a wall of sixty identical text tiles («CH24 · dining-chairs») under a
 * caption claiming 257, because `op: 'models'` carried nothing but the code.
 * The owner's verdict on that screen (2026-09-02) is what this rewrite
 * answers, and the design-system rules it now obeys are the ones RosetSoft
 * pins (`docs/design-system.md`): a search field with a bound label, counts
 * as tabular figures, codes with a slashed zero, no text under ink-500, the
 * notice band as the recipe, and a truncation that is a number the visitor
 * can act on («Ver 48 más») rather than a silence.
 */

const money = (n, currency = 'USD') =>
  n == null ? null : new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(n);

export default function CarlHansenEmbed() {
  const [models, setModels] = useState(null);   // null = loading
  const [listError, setListError] = useState('');
  const [facesDown, setFacesDown] = useState(false); // the page cache could not be read
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(CH_PICKER_PAGE);
  const [modelId, setModelId] = useState('');
  const [face, setFace] = useState(null);       // the picker card that was opened
  const [data, setData] = useState(null);       // { spec, priceRow, page, errors }
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchChModels().then((r) => {
      if (!alive) return;
      if (r?.ok) { setModels(r.models || []); setFacesDown(r.faces === 'unavailable'); }
      else { setModels([]); setListError(r?.error || 'No se pudo leer el catálogo.'); }
    });
    return () => { alive = false; };
  }, []);

  // A new model is a new configuration: the previous selection names axes this
  // one does not have, and carrying it over would compose a key out of another
  // chair's leaves. The card that was tapped stays on screen as the ficha's
  // head while the four reads land — the name and the photo are already known.
  const open = useCallback(async (card) => {
    setModelId(card.modelId);
    setFace(card);
    setSelection(null);
    setData(null);
    setLoading(true);
    const next = await fetchChConfiguration(card.modelId);
    setData(next);
    setLoading(false);
  }, []);

  const close = useCallback(() => { setModelId(''); setFace(null); setData(null); }, []);

  const vm = useMemo(() => {
    if (!data?.spec) return null;
    return resolveCarlHansenConfigurator(data.spec, data.priceRow, data.page, { selection });
  }, [data, selection]);

  const notice = useMemo(() => chPublicNotice(vm), [vm]);

  const pick = useCallback((axisId, key) => {
    setSelection((s) => ({ ...(s || {}), [axisId]: key }));
  }, []);

  // A new search starts the page count over: «Ver más» on a stale query would
  // reveal cards the visitor never asked for.
  const search = useCallback((value) => { setQ(value); setLimit(CH_PICKER_PAGE); }, []);

  const picker = useMemo(
    () => resolveChPicker(models || [], { query: q, limit }),
    [models, q, limit],
  );

  if (!modelId) {
    return (
      <Frame>
        <header>
          <p className="eyebrow">Configurador</p>
          <h1 className="mt-1 font-display text-2xl text-ink-900">Carl Hansen &amp; Søn</h1>
          <p className="mt-1 text-sm text-ink-500">
            Elige una pieza y configúrala. Precios de lista del fabricante, en dólares.
          </p>
        </header>

        <label className="mt-5 block">
          <span className="sr-only">Buscar una pieza</span>
          <input
            type="search"
            value={q}
            onChange={(e) => search(e.target.value)}
            placeholder="Buscar — Wishbone, CH24, Wegner, butacas…"
            autoComplete="off"
            className="input search-clean"
          />
        </label>

        {models === null && <PickerSkeleton />}

        {listError && <Notice tone="danger" className="mt-4">{listError}</Notice>}

        {models !== null && !listError && (
          <>
            <p role="status" className="mt-3 text-xs text-ink-500">
              <span className="num">{picker.total}</span> piezas publicadas
              {picker.query
                ? <> · <span className="num">{picker.matched}</span> {picker.matched === 1 ? 'coincide' : 'coinciden'}</>
                : null}
            </p>

            {/* The page cache was down, not empty: say which, or a picker
                with no photos reads as a catalogue nobody swept. */}
            {facesDown && picker.faces === 0 && (
              <Notice tone="info" dense className="mt-3">
                Las fotos no se pudieron leer ahora mismo — las piezas y sus precios sí.
              </Notice>
            )}

            {picker.query && picker.matched === 0 && (
              <div className="mt-6">
                <EmptyState
                  icon={SearchX}
                  title={`Nada coincide con «${picker.query}»`}
                  description="Busca por nombre (Wishbone), código (CH24), diseñador (Wegner) o estante (butacas)."
                  action={<button type="button" className="btn-secondary" onClick={() => search('')}>Ver todas las piezas</button>}
                />
              </div>
            )}

            <div className="mt-5 space-y-7">
              {picker.sections.map((section) => (
                <section key={section.key} aria-labelledby={`ch-shelf-${section.key}`}>
                  <div className="section-rule">
                    <span id={`ch-shelf-${section.key}`}>{section.label}</span>
                    <span className="text-micro text-ink-500 num">{section.cards.length}</span>
                  </div>
                  <ul className="mt-3 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4">
                    {section.cards.map((card) => (
                      <li key={card.modelId} className="min-w-0">
                        <PickerCard card={card} onOpen={open} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            {/* A truncation is a number, and the number is a button. */}
            {picker.hidden > 0 && (
              <div className="mt-7 flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setLimit((n) => n + CH_PICKER_PAGE)}
                >
                  Ver <span className="num">{Math.min(CH_PICKER_PAGE, picker.hidden)}</span> más
                </button>
                <span className="text-xs text-ink-500">
                  <span className="num">{picker.shown}</span> de <span className="num">{picker.matched}</span>
                </span>
              </div>
            )}
          </>
        )}
      </Frame>
    );
  }

  // EL 3D SÓLO CUANDO PUEDE PINTAR. Un binding hecho de nombres de textura no
  // casa con ningún material de la malla, así que el escenario saldría
  // completamente BLANCO al lado de un selector que dice «Roble FSC · Laca»:
  // una foto que gira y que además miente sobre el color. La fotografía del
  // fabricante es la respuesta honesta hasta que un humano confirme el binding.
  const rawAsset = data?.asset || null;
  const asset = rawAsset?.meshUrl && chBindingPaints(rawAsset.binding) ? rawAsset : null;

  return (
    <Frame>
      <button type="button" onClick={close} className="btn-ghost -ml-3">
        <ArrowLeft size={15} aria-hidden /> Todas las piezas
      </button>

      {/* The head the visitor already saw on the card, so the tap lands on the
          chair they chose and not on a blank page with a spinner. */}
      {loading && face && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div>
            {face.imageSrc && (
              <img
                src={chCoverImageUrl(face.code, face.imageSrc, 'preview')}
                alt={face.name || face.code}
                className="w-full rounded-xl bg-ink-50 object-contain max-h-[26rem]"
              />
            )}
            <h1 className="mt-4 font-display text-2xl text-ink-900">{face.name || face.code}</h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {face.designer ? <>{face.designer} · </> : null}<span className="code">{face.code}</span>
            </p>
            <p className="mt-5 inline-flex items-center gap-2 text-sm text-ink-500">
              <Loader2 size={14} className="animate-spin" aria-hidden /> Leyendo opciones y precios…
            </p>
          </div>
        </div>
      )}

      {/* NAMED, NOT SWALLOWED. Which half is missing is the useful part: a
          model with no price list is still a chair worth looking at, and the
          visitor deserves to know that is what happened. */}
      {!loading && data?.errors?.length > 0 && (
        <Notice tone="warn" className="mt-4">
          {data.errors.map((e) => e.message).filter(Boolean).join(' · ')}
        </Notice>
      )}

      {vm && (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div>
            {/* THE 3D WHEN THERE IS ONE, THE PHOTOGRAPH WHEN THERE IS NOT.
                The material→axis binding a dealer confirmed is exactly what
                makes picking «Walnut, oiled» repaint the mesh's wood groups
                and nothing else. Without a converted mesh this is the
                manufacturer's photography, which is an honest answer rather
                than a hole. */}
            {asset?.meshUrl ? (
              <figure className="rounded-xl border border-ink-100 bg-ink-50/40 overflow-hidden">
                <div className="h-[320px] sm:h-[440px] w-full">
                  <ChStage
                    meshUrl={asset.meshUrl}
                    axes={vm.axes}
                    binding={asset.binding}
                    className="h-full w-full"
                  />
                </div>
                <figcaption className="px-3 py-2 text-micro text-ink-500 border-t border-ink-100 inline-flex items-center gap-1.5">
                  <RotateCw size={12} aria-hidden />
                  Arrastra para girar · rueda para acercar
                </figcaption>
              </figure>
            ) : vm.images?.[0]?.url ? (
              <img
                src={vm.images[0].url}
                alt={vm.modelName}
                className="w-full rounded-xl bg-ink-50 object-contain max-h-[26rem]"
              />
            ) : null}
            <h1 className="mt-4 font-display text-2xl text-ink-900">{vm.modelName}</h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {face?.designer ? <>{face.designer} · </> : null}<span className="code">{vm.modelId}</span>
            </p>

            <div className="mt-5 space-y-5">
              {vm.axes.map((axis) => (
                <Axis key={axis.id} axis={axis} onPick={(key) => pick(axis.id, key)} />
              ))}
            </div>
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start space-y-3">
            <div className="card p-4">
              <div className="eyebrow">Precio de lista</div>
              <div className="mt-1 text-2xl font-semibold text-ink-900 num">
                {money(vm.listPriceUsd, vm.currency) ?? 'Sin precio'}
              </div>
              {/* A refusal states its reason. "Sin precio" with no explanation
                  reads as a broken page rather than as an unpublished
                  combination. */}
              {vm.listPriceUsd == null && (
                <p className="mt-1 text-xs text-ink-500">
                  {vm.priceState === 'unknown'
                    ? 'Carl Hansen no publica lista de precios para esta pieza.'
                    : 'Esta combinación no tiene precio publicado. Prueba otra opción.'}
                </p>
              )}
              {vm.priceState === 'stale' && (
                <p className="mt-1 text-xs text-status-warning-ink">La lista venció — confirma antes de cotizar.</p>
              )}

              <dl className="mt-3 space-y-1 text-xs">
                <Row label="Referencia" value={vm.variant?.sku || '—'} mono />
                <Row label="Entrega" value={vm.leadTimeDays ? `${vm.leadTimeDays} días` : 'A confirmar'} />
                <Row label="Clave" value={vm.priceKey?.key || '—'} mono />
              </dl>
            </div>

            {/* EN EL IDIOMA DEL CLIENTE. Los avisos del ViewModel están
                escritos para el dealer que importa el catálogo («no hay EAN
                que importar»); un visitante no importa EANs. `chPublicNotice`
                se queda con lo único que le concierne y lo dice en su idioma. */}
            {notice && <Notice tone="warn" dense>{notice}</Notice>}
          </aside>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`text-ink-700 text-right ${mono ? 'code' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * One picker card: the cover, the name, the designer, the code. The name
 * leads because it is what a visitor knows the chair by; the code is there
 * because it is what a dealer will ask for. A model nobody swept yet shows
 * its code as the title and «sin foto» — a bare card is the honest shape of
 * "not swept", and a placeholder that pretended to be a photo would not be.
 */
function PickerCard({ card, onOpen }) {
  const title = card.name || card.code;
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      title={card.name ? `${card.code} · ${card.name}` : card.code}
      className="card w-full overflow-hidden text-left transition-shadow hover:shadow-md hover:border-ink-300 active:shadow-sm"
    >
      <ChPhoto src={chCoverImageUrl(card.code, card.imageSrc, 'thumb')} alt={title} />
      <span className="block px-3 py-2.5">
        <span className="block truncate font-display text-sm font-semibold text-ink-900">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-500">
          {card.designer || (card.name ? '' : 'Sin ficha todavía')}
        </span>
        {card.name && <span className="mt-1 block text-micro text-ink-500 code">{card.code}</span>}
      </span>
    </button>
  );
}

/** The grid's silhouette while the list loads — the same boxes the cards
 *  will fill, so nothing reflows when they land. */
function PickerSkeleton() {
  return (
    <ul className="mt-5 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 animate-pulse" aria-busy="true" aria-label="Leyendo el catálogo…">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="card overflow-hidden">
          <span className="block aspect-[4/3] w-full bg-ink-50" />
          <span className="block px-3 py-2.5">
            <span className="block h-2 w-2/3 rounded-full bg-ink-100" />
            <span className="mt-2 block h-2 w-1/3 rounded-full bg-ink-100/70" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One axis.
 *
 * THE INSTRUMENT FOLLOWS THE MATERIAL, not a hardcoded list of axis ids: a
 * `wood`, `upholstery` or `cord` axis is a swatch grid because those choices
 * are about how something LOOKS, and anything else is a row of buttons because
 * `Height: LOW / HIGH` is not a colour. `chAxisKind` reads that off the tree, so
 * a model Carl Hansen adds next year renders correctly without being listed
 * anywhere here.
 *
 * The group label is what keeps 32 upholstery leaves from being a wall: the
 * nearest visible ancestor — "Canvas", "Loke", "FSC™-certified Oak" — is the
 * heading the leaves sit under.
 */
function Axis({ axis, onPick }) {
  const swatchy = axis.kind === 'wood' || axis.kind === 'upholstery' || axis.kind === 'cord';
  const groups = useMemo(() => {
    const out = new Map();
    for (const o of axis.options) {
      const key = o.groupLabel || '';
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(o);
    }
    return [...out.entries()];
  }, [axis.options]);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-900">{axis.label}</h2>
        <span className="text-xs text-ink-500 truncate">{axis.selected?.label || ''}</span>
      </div>

      {groups.map(([group, options]) => (
        <div key={group} className="mt-2">
          {group && <div className="text-xs text-ink-500 mb-1">{group}</div>}
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onPick(o.key)}
                title={o.fullLabel || o.label}
                aria-pressed={o.selected}
                className={`min-h-11 rounded-lg border text-xs transition-colors ${
                  o.selected ? 'border-ink-900 bg-ink-900 text-ink-50' : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                } ${swatchy && o.swatch ? 'p-0 overflow-hidden w-11' : 'px-2.5 py-1.5'}`}
              >
                {swatchy && o.swatch
                  ? <img src={o.swatch} alt={o.label} className="w-11 h-11 object-cover" />
                  : (
                    <span>
                      {o.label}
                      {/* Only a DECLINABLE extra shows a surcharge. A mandatory
                          one is already inside the list price, and printing it
                          beside the option would read as "add $145" on a figure
                          that already contains it. */}
                      {o.addOnKind === 'accessory' && o.addOnUsd
                        ? <span className="opacity-60"> +{money(o.addOnUsd)}</span>
                        : null}
                    </span>
                  )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
