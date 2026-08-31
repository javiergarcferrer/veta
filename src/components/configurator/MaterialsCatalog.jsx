import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Check, ChevronLeft } from 'lucide-react';
import { isMaterialOffered } from '../../lib/nameKey.js';
import { activeCatalogModule } from '../../brands/runtime.js';
import { productForGrade } from '../../lib/catalog.js';
import { locateColor } from '../../lib/swatchMatch.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { placeSwatchPreview } from '../../lib/configurator/swatchPreview.js';
import SwatchPreviewCard from './SwatchPreviewCard.jsx';
import { t } from '../../lib/configurator/i18n.js';

/**
 * The desktop 3D sidepane's material catalog — TWO LEVELS OF TILES (owner,
 * 2026-08-01: «las telas no la despliegues así todas juntas, haz como tiles
 * para cada tipo de tela»). The wall this replaces poured every material's every
 * colour into one scroller — 667 swatches — so the pane answered "which colours
 * exist" before anyone had asked "which TELA", and the answer was a scroll long
 * enough that neither question got read. What it must NOT go back to is the
 * dropdown before it («i dont like the dropdown material finder. its horrible»):
 * the fix is fewer things on screen, not the same catalog behind a click.
 *
 *   • PINNED — the search, plus (level 1) the category chips or (level 2) the
 *     open material's header. A flex SIBLING of the scroller rather than
 *     `position: sticky`: it can never scroll away and needs no opaque patch
 *     over the glass `hud-panel`.
 *   • LEVEL 1 · TIPOS DE TELA — every offered material as a 2-up tile: its hero
 *     swatch nearly full-bleed (the material's first colour, the same
 *     `swatchSrc` route the colour cards take), then name · grade · nº colores ·
 *     price. A material is a PHOTO here, not a line of text — which is the whole
 *     point: telas are chosen by eye.
 *   • LEVEL 2 · SUS COLORES — the chosen material's colours as the same 3-up
 *     photo grid the wall used, under a compact header (« Materiales · name ·
 *     grade · price · nº colores · composición). The back idiom is the dealer
 *     picker's (MaterialColorPicker's ColorGrid): the button names the
 *     DESTINATION, so it reads as a place, not an undo.
 *
 * Search spans both levels and narrows IN PLACE, never into a result list. At
 * level 1 a material matched by its OWN identity (name / grade / composition)
 * shows as itself, while one matched only through a colour keeps the hit count
 * as a hint — so "anis" surfaces the tiles that HAVE an ANIS and says how many.
 * Opening such a tile lands on exactly those colours (the hint's payoff); the
 * ✕ clears back to the full set. Nothing left at all is the empty state.
 *
 * Auto-drill: with a fabric already on the target, the pane opens DIRECTLY in
 * that material's colours — the dealer's flow is re-picking a shade, not
 * re-picking a tela — with the current colour ringed, checked and scrolled to.
 * It fires ONCE (the flag is set even with no current fabric), so a later pick
 * can never yank the pane out from under the visitor. «Materiales» returns to
 * the tiles AT THE SCROLL POSITION THEY WERE LEFT — the tile grid is browsing
 * state, and losing it on every drill is what makes a two-level pane feel like
 * a maze.
 *
 * Same offering rules as the modal picker: only `isMaterialOffered` materials,
 * restricted to the model's offered set (`nameFilter`, a Set of fabricKey
 * values) when one exists.
 *
 * HOVER IS THE ZOOM (owner, 2026-08). Every tile — a tela at level 1, a colour
 * at level 2 — opens a big square of that cloth beside the rail while the
 * pointer rests on it. It replaces a ✕-sized magnifier that sat in each colour
 * cell's top-right corner: a control you had to SEE, then AIM AT, to answer
 * "what does this actually look like" — the one question the whole pane exists
 * for. Hovering already means "this one"; nothing else had to be true.
 * `SwatchPreviewCard` (shared with the 3D stage) paints it, `placeSwatchPreview`
 * (lib/togo) decides where.
 *
 * `swatchSrc(color, cssPx)` takes the whole COLOUR and the size the tile
 * actually paints at, not just a code: the host resolves it to the smallest
 * route available (see lib/swatchImage `swatchTileUrl`). Leaving out the size
 * would put a 2000-px, 250 KB original in a 96-px cell — and asking for the
 * PREVIEW size is what makes the hover card genuinely high-resolution rather
 * than a stretched thumbnail. `swatchFallbackSrc` is the same signature for the
 * one route that is NOT the Ligne Roset photo (the colour's own scan): reached
 * only when LR's 404s, so the wall stays one catalogue and never an empty cell.
 */

// Both tiles MEASURED off the rail (w-80 = 320 px) inside the grid's px-2.5:
// level 1 is 2 columns with gap-1.5 → (320−20−6)/2 = 147; level 2 is 3 →
// (320−20−12)/3 ≈ 96. The host doubles for the device pixel ratio and snaps to
// its own ladder.
const MATERIAL_TILE_PX = 147;
const GRID_TILE_PX = 96;
// The hover card's cloth. Big enough to judge a weave (≈3.5× a colour cell),
// small enough to clear the rail on a 1280-px workspace with room to spare.
const PREVIEW_PX = 336;

// Hover previews are for pointers that HOVER. A touch tap synthesizes
// mouseenter, so without this the card would fly open on the very tap that
// picks a colour and then sit there over the wall. Keyboard focus is handled
// separately (:focus-visible), which is the same distinction the browser draws.
const FINE_POINTER = typeof window !== 'undefined'
  && !!window.matchMedia?.('(pointer: fine)').matches;

/** Focus that arrived from the KEYBOARD — a tap also focuses, and that must not
 *  open the card. `:focus-visible` is the browser's own answer; a browser too
 *  old to know the selector throws, and a picker must never crash over a
 *  decoration. */
function keyboardFocused(el) {
  try {
    return !!el?.matches?.(':focus-visible');
  } catch {
    return false;
  }
}

export default function MaterialsCatalog({
  locale,
  materials,
  family = null,
  nameFilter,
  currentGrade,
  currentFabric,
  pricesHidden = false,
  fmt,
  swatchSrc,
  swatchFallbackSrc = null,
  onPick,
  // DOCK the hover preview instead of floating it. Given a reporter, this pane
  // renders NO card of its own and hands the hovered swatch up, so the host can
  // paint it in the ONE slot it already owns. Owner, 2026-08: a floating card
  // over the wall while the pane's own docked preview was on screen put TWO
  // previews up at once — the exact thing «we have only one preview modal»
  // forbids. Without the prop, the floating card is unchanged.
  onDockPreview = null,
}) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  // EL BUSCADOR NO COBRA ALTURA HASTA QUE SE USA (dueño, 2026-08-05: «collapse
  // search into an expandable button»). En una hoja de media pantalla el campo
  // se comía un renglón entero de muro para una función que casi nadie abre —
  // 25 colores se miran, no se teclean. Plegado es un botón; abierto es el
  // mismo campo de siempre en su propia fila.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  // Abrirlo enfoca: si hay que tocar dos veces para escribir, el botón es un
  // peaje y no un atajo.
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  // Cerrarlo LIMPIA. Un filtro escondido que sigue quitando colores es una
  // trampa: el muro se ve incompleto y nada en pantalla dice por qué. Por eso
  // la fila tampoco se pliega sola mientras haya texto.
  const closeSearch = useCallback(() => { setSearchOpen(false); setQ(''); }, []);
  // The material whose colours are on screen — null IS level 1.
  const [openId, setOpenId] = useState(null);

  const scrollerRef = useRef(null);
  const activeTileRef = useRef(null);
  const tilesScroll = useRef(0);   // where level 1 was left, restored by «Materiales»

  // ── The hover card ────────────────────────────────────────────────────
  // WHAT is previewed is React state; WHERE it sits is written straight to the
  // node. The card has to follow its tile while the wall scrolls under a
  // stationary pointer, and re-rendering 58 tiles per scroll frame to move one
  // box is exactly the per-frame cost this pane was rebuilt to avoid (see
  // `hud-panel-solid` in index.css). Same split the 3D hover chip makes.
  const [preview, setPreview] = useState(null);
  const anchorRef = useRef(null);   // the tile the card belongs to
  const cardRef = useRef(null);
  const closeTimer = useRef(0);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const { left, top } = placeSwatchPreview({
      anchor: anchor.getBoundingClientRect(),
      box: { width: card.offsetWidth, height: card.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }, []);

  // Closing is DELAYED and the next hover cancels it (the same idiom the 3D
  // hover chip uses). Leaving a tile and entering its neighbour are two separate
  // events, so an immediate close would unmount the card and mount a new one —
  // replaying its entry animation on every tile the pointer crosses, which is a
  // wall that flickers rather than a card that follows. It also bridges the
  // 6-px gutter BETWEEN tiles, which the pointer crosses on the way.
  const onPreview = useCallback((el, info) => {
    clearTimeout(closeTimer.current);
    if (info) { anchorRef.current = el; setPreview(info); return; }
    // A leave from a tile we have already moved off must not close the card
    // that just opened over its neighbour.
    if (el && anchorRef.current !== el) return;
    closeTimer.current = setTimeout(() => { anchorRef.current = null; setPreview(null); }, 90);
  }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  // Reported through a REF: the host passes an inline arrow, and depending on
  // its identity would re-fire this on every render of a scrolling wall.
  const dockRef = useRef(onDockPreview);
  dockRef.current = onDockPreview;
  useEffect(() => { dockRef.current?.(preview); }, [preview]);
  // …and the slot must not keep a card belonging to a pane that has closed.
  useEffect(() => () => dockRef.current?.(null), []);

  // Placed before the browser paints, so the card is never seen at 0,0.
  useLayoutEffect(() => { if (preview) place(); }, [preview, place]);
  useEffect(() => {
    if (!preview) return undefined;
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [preview, place]);
  // Drilling, searching or filtering can pull the hovered tile out from under
  // the pointer — and a card whose anchor has unmounted would hang there,
  // previewing a swatch the wall no longer shows.
  useEffect(() => {
    clearTimeout(closeTimer.current);
    anchorRef.current = null;
    setPreview(null);
  }, [openId, q, category]);

  const offered = useMemo(() => {
    const allow = nameFilter && nameFilter.size ? nameFilter : null;
    return (materials || [])
      .filter(isMaterialOffered)
      .filter((m) => (allow ? allow.has(activeCatalogModule().fabricKey(m.name)) : true))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [materials, nameFilter]);

  // The material holding the target's CURRENT fabric — the auto-drill's landing
  // point (the host remounts the catalog per target).
  const currentId = useMemo(() => {
    if (!currentFabric) return null;
    return locateColor(offered, composeSubtype(currentGrade, currentFabric))?.material?.id ?? null;
  }, [offered, currentGrade, currentFabric]);

  // Category chips only when the offering actually spans categories.
  const cats = useMemo(() => {
    const present = new Set(offered.map((m) => m.category).filter(Boolean));
    return CATEGORIES.filter((c) => present.has(c.k));
  }, [offered]);

  const needle = q.trim().toLowerCase();

  // LEVEL 1 — [{ m, colors, hits }] in offered order. `hits` > 0 marks a
  // material reached ONLY through its colours: it carries just those (so
  // opening it lands on them) and says how many.
  const tiles = useMemo(() => {
    const out = [];
    for (const m of offered) {
      if (category && m.category !== category) continue;
      const colors = m.colors || [];
      if (!colors.length) continue;   // nothing to pick — never a bare tile
      if (!needle || matchesSelf(m, needle)) { out.push({ m, colors, hits: 0 }); continue; }
      const found = colors.filter((c) => matchesColor(c, needle));
      if (found.length) out.push({ m, colors: found, hits: found.length });
    }
    return out;
  }, [offered, needle, category]);

  // LEVEL 2 — resolved off `offered`, never off `tiles`: typing or switching a
  // category while inside a material must filter its colours, not eject you.
  const open = useMemo(
    () => (openId ? offered.find((m) => m.id === openId) || null : null),
    [offered, openId],
  );
  const openColors = useMemo(() => {
    const colors = open?.colors || [];
    if (!open || !needle || matchesSelf(open, needle)) return colors;
    return colors.filter((c) => matchesColor(c, needle));
  }, [open, needle]);

  // Land ON the current fabric's material. The async catalog may arrive after
  // mount, so wait for the offered list, then run ONCE.
  const didAuto = useRef(false);
  useEffect(() => {
    if (didAuto.current || !offered.length) return;
    didAuto.current = true;
    if (currentId) setOpenId(currentId);
  }, [offered, currentId]);

  // The scroller belongs to the level that is showing: entering a material
  // starts at its top (then nudges the current colour into view, once), and
  // «Materiales» restores the tile grid exactly where it was left.
  const landedOn = useRef(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!openId) { el.scrollTop = tilesScroll.current; landedOn.current = null; return; }
    el.scrollTop = 0;
    if (landedOn.current === openId) return;
    landedOn.current = openId;
    activeTileRef.current?.scrollIntoView({ block: 'nearest' });
  }, [openId]);

  const priceFor = (m) => (family && !pricesHidden && fmt
    ? productForGrade(family, String(m.grade || '').toUpperCase())?.priceUsd ?? null
    : null);
  // Definido AQUI, no arriba con su estado: lee `open` (el material
  // abierto) para su etiqueta, y `open` se calcula mas abajo — construirlo
  // antes lo dejaba en la zona muerta del const y el catalogo entero moria
  // en ReferenceError al primer render. Lo caza el arnes, no el build.
  const searchButton = (
    <button
      type="button"
      onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
      aria-label={t(locale, open ? 'fabric.paneSearchColor' : 'fabric.paneSearch')}
      aria-expanded={searchOpen}
      className={`shrink-0 grid place-items-center w-7 h-7 rounded-lg border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        searchOpen || q
          ? 'border-brand-300 bg-brand-50 text-brand-700'
          : 'border-ink-200 text-ink-500 hover:bg-ink-100 hover:text-ink-800'
      }`}
    >
      {searchOpen ? <X size={13} aria-hidden /> : <Search size={13} aria-hidden />}
    </button>
  );

  const openMaterial = (id) => {
    tilesScroll.current = scrollerRef.current?.scrollTop || 0;
    setOpenId(id);
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* PINNED — held by the flex row, not by `position: sticky` (docblock). */}
      <div className="shrink-0 px-3 pb-2 flex flex-col gap-2">
        {/* IDENTIDAD Y CONTROLES EN UNA SOLA FILA. Eran dos: una con el
            «‹ Materiales» y el precio (casi vacía) y otra con el nombre y su
            meta. En una hoja de media pantalla ese renglón de más es muro de
            telas que no se ve, así que el volver queda en su flecha (la
            etiqueta la dice el aria-label) y el nombre sube a su lado. El
            precio y el grade no se van a ninguna parte — son la razón de
            elegir esta tela y no la de al lado. */}
        {open && (
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              type="button"
              onClick={() => setOpenId(null)}
              aria-label={t(locale, 'fabric.paneBack')}
              className="-ml-1 shrink-0 grid place-items-center w-7 h-7 rounded-md text-ink-600 hover:bg-ink-100 hover:text-ink-800 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <div className="min-w-0 flex-1" title={open.composition || open.name}>
              <div className="truncate text-xs font-semibold text-ink-800">{open.name}</div>
              {/* Composition is the deciding read AND a search target, so it
                  stays visible — truncated onto the count's line, which costs
                  the header no extra height. */}
              <div className="flex items-baseline gap-1.5 min-w-0 text-micro leading-snug text-ink-500">
                <span className="shrink-0 tabular-nums">{colorsLabel(locale, openColors.length)}</span>
                {open.composition && <span className="min-w-0 truncate">· {open.composition}</span>}
              </div>
            </div>
            <span className="shrink-0 flex items-baseline gap-1.5">
              {open.grade && <GradeBadge grade={open.grade} />}
              {priceFor(open) != null && (
                <span className="text-micro font-medium text-ink-600 tabular-nums">
                  {shortMoney(fmt, priceFor(open))}
                </span>
              )}
            </span>
            {searchButton}
          </div>
        )}
        {/* Categories sort TELAS — inside one material they'd sort nothing. El
            botón del buscador viaja con ellas: al nivel 1 no hay fila de
            identidad donde ponerlo, y una fila propia para un solo botón
            gastaría justo lo que este cambio ahorra. */}
        {!open && (
          <div className="flex items-center gap-1 min-w-0">
            <div className="min-w-0 flex-1 flex flex-wrap gap-1">
              {cats.length > 1 && (
                <>
                  <FilterChip active={!category} onClick={() => setCategory('')}>{t(locale, 'fabric.paneAll')}</FilterChip>
                  {cats.map((c) => (
                    <FilterChip key={c.k} active={category === c.k} onClick={() => setCategory(category === c.k ? '' : c.k)}>
                      {t(locale, c.label)}
                    </FilterChip>
                  ))}
                </>
              )}
            </div>
            {searchButton}
          </div>
        )}
        {/* El campo, solo cuando se pidió. */}
        {searchOpen && (
          <div className="relative">
            {/* type="text", not "search": the native clear glyph is a second,
                unstyled control inside a field that already has ✕. */}
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
              placeholder={t(locale, open ? 'fabric.paneSearchColor' : 'fabric.paneSearch')}
              aria-label={t(locale, open ? 'fabric.paneSearchColor' : 'fabric.paneSearch')}
              className="w-full rounded-lg border border-ink-200 bg-surface pl-8 pr-7 py-1.5 text-xs text-ink-800 placeholder:text-ink-500 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-300 transition"
            />
            {q && (
              <button
                type="button"
                onClick={() => { setQ(''); searchRef.current?.focus(); }}
                aria-label={t(locale, 'common.close')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-5 h-5 rounded-full text-ink-500 hover:bg-ink-100 hover:text-ink-600 transition"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* The pane's ONLY scrolling region, and it owns it — both levels grid
          into the same inset, so drilling never shifts the columns' edges. */}
      <div
        ref={scrollerRef}
        /* The card is anchored to a tile INSIDE this scroller, so scrolling
           moves it — re-placed, not closed: the pointer never left the swatch. */
        onScroll={place}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-thin pb-2"
      >
        {open ? (
          openColors.length === 0 ? (
            <Empty locale={locale} />
          ) : (
            <div className="grid grid-cols-3 gap-1.5 px-2.5 pt-1.5 pb-3">
              {openColors.map((c) => {
                const active = !!(currentFabric && c.code && currentFabric.includes(c.code) && open.id === currentId);
                return (
                  <ColorTile
                    key={c.code || c.name}
                    innerRef={active ? activeTileRef : undefined}
                    label={composeFabricLabel(open, c)}
                    color={c}
                    active={active}
                    swatchSrc={swatchSrc}
                    swatchFallbackSrc={swatchFallbackSrc}
                    onPick={() => onPick(open, c)}
                    onPreview={onPreview}
                    /* The colour IS the subject here; the tela it belongs to is
                       context, and the code is what the dealer quotes. */
                    preview={{
                      title: c.name || open.name,
                      meta: [open.name, c.code ? `#${c.code}` : null].filter(Boolean).join(' · '),
                      src: swatchSrc(c, PREVIEW_PX),
                      base: swatchSrc(c, GRID_TILE_PX),
                      fallback: swatchFallbackSrc?.(c, PREVIEW_PX) || null,
                    }}
                  />
                );
              })}
            </div>
          )
        ) : tiles.length === 0 ? (
          // Only once the catalog has actually landed — a still-loading pane
          // must not flash "sin resultados".
          offered.length > 0 && <Empty locale={locale} />
        ) : (
          <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 pb-3">
            {tiles.map(({ m, colors, hits }) => (
              <MaterialTile
                key={m.id}
                locale={locale}
                material={m}
                colors={colors}
                hits={hits}
                current={m.id === currentId}
                price={priceFor(m)}
                fmt={fmt}
                swatchSrc={swatchSrc}
                swatchFallbackSrc={swatchFallbackSrc}
                onOpen={() => openMaterial(m.id)}
                onPreview={onPreview}
              />
            ))}
          </div>
        )}
      </div>

      {/* Portaled: the rail clips its own overflow (and is 320 px wide), so a
          card rendered inside it could neither escape nor be large. Skipped
          entirely when the host docks it — one preview, one place. */}
      {preview && !onDockPreview && createPortal(
        <SwatchPreviewCard innerRef={cardRef} preview={preview} width={PREVIEW_PX} />,
        document.body,
      )}
    </div>
  );
}

const CATEGORIES = [
  { k: 'fabric', label: 'fabric.catFabric' },
  { k: 'leather', label: 'fabric.catLeather' },
  { k: 'outdoor', label: 'fabric.catOutdoor' },
];

/** A material matched by its OWN identity — it then shows ALL its colours. */
function matchesSelf(m, needle) {
  return !!(
    m.name?.toLowerCase().includes(needle)
    || String(m.grade || '').toLowerCase() === needle
    || m.composition?.toLowerCase().includes(needle)
  );
}

function matchesColor(c, needle) {
  return !!(c.name?.toLowerCase().includes(needle) || c.code?.includes(needle));
}

/** Prices read as a ladder here, not as an amount to pay — the cents are noise. */
function shortMoney(fmt, v) {
  return fmt(v)?.replace(/\.\d\d$/, '');
}

/** «58 colores» / «1 color» — a one-colour material is real (ACATE), and it is
 *  the second line of every tile, so the singular is worth a key. */
function colorsLabel(locale, n) {
  return t(locale, n === 1 ? 'fabric.paneColorOne' : 'fabric.paneColors', { n });
}

/** LEVEL 1 — a TIPO DE TELA: its hero swatch, then who it is. Navigation, not a
 *  toggle, so it carries `aria-current` rather than `aria-pressed`; the pick is
 *  one level down and only colour tiles claim that state. */
function MaterialTile({
  locale, material, colors, hits, current, price, fmt,
  swatchSrc, swatchFallbackSrc, onOpen, onPreview,
}) {
  // The face is a real colour of this material (the first that resolves), so
  // when a search narrowed to colour hits the tile SHOWS one of them.
  const hero = colors.find((c) => c.code) || colors[0] || null;
  // A tela previews through the very colour its tile is wearing.
  const preview = hero && {
    title: material.name,
    meta: [hero.name, material.grade ? `Grade ${material.grade}` : null, material.composition]
      .filter(Boolean).join(' · '),
    src: swatchSrc(hero, PREVIEW_PX),
    base: swatchSrc(hero, MATERIAL_TILE_PX),
    fallback: swatchFallbackSrc?.(hero, PREVIEW_PX) || null,
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? 'true' : undefined}
      title={material.composition || material.name}
      {...hoverPreviewProps(onPreview, preview)}
      className={`group relative block w-full overflow-hidden rounded-lg border text-left transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        current
          ? 'border-brand-400 ring-2 ring-brand-400'
          : 'border-ink-100 hover:border-brand-300 hover:shadow-sm'
      }`}
    >
      <span className="relative block aspect-square w-full overflow-hidden bg-ink-50">
        <SwatchImg
          color={hero}
          px={MATERIAL_TILE_PX}
          src={swatchSrc}
          fallbackSrc={swatchFallbackSrc}
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
        {/* The grade RIDES the swatch — exactly where a physical sample book
            stamps it, and it buys the name the tile's full width back: sharing
            a line, "ALCANTARA - A" and "- B" both truncated to "ALCANT…" and
            the two tiles became indistinguishable. */}
        {material.grade && (
          <span className="absolute left-1 top-1"><GradeBadge grade={material.grade} overlay /></span>
        )}
      </span>
      <span className="block px-1.5 pt-1 pb-1.5">
        {/* Truncate, never wrap — "ANTHR ACITE" mid-word breaks are the bug
            this pane replaced. */}
        <span className="block truncate text-micro font-semibold leading-tight text-ink-800">{material.name}</span>
        <span className="mt-px flex items-baseline gap-1 min-w-0 text-micro leading-snug">
          <span className={`min-w-0 truncate tabular-nums ${hits ? 'font-medium text-brand-600' : 'text-ink-500'}`}>
            {hits
              ? t(locale, hits === 1 ? 'fabric.paneMatchOne' : 'fabric.paneMatchOther', { n: hits })
              : colorsLabel(locale, colors.length)}
          </span>
          {price != null && (
            <span className="shrink-0 ml-auto font-medium text-ink-600 tabular-nums">{shortMoney(fmt, price)}</span>
          )}
        </span>
      </span>
      {current && (
        <span className="absolute right-1 top-1 grid place-items-center w-[18px] h-[18px] rounded-full bg-brand-600 text-white shadow-sm pointer-events-none">
          <Check size={11} strokeWidth={3} aria-hidden />
        </span>
      )}
    </button>
  );
}

/** LEVEL 2 — one colour. Tapping applies it live (the pane persists, so
 *  exploring shades is one continuous loop with the 3D); hovering opens the
 *  cloth full-size beside the rail (see the file docblock — this is where the
 *  corner magnifier used to be, and the corner is now the check's alone). */
function ColorTile({ innerRef, label, color, active, swatchSrc, swatchFallbackSrc, onPick, onPreview, preview }) {
  return (
    <div ref={innerRef} className="relative group">
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        title={label}
        {...hoverPreviewProps(onPreview, preview)}
        className={`block w-full overflow-hidden rounded-lg border text-left transition active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          active
            ? 'border-brand-400 ring-2 ring-brand-400'
            : 'border-ink-100 hover:border-brand-300 hover:shadow-sm'
        }`}
      >
        <span className="block aspect-square w-full overflow-hidden bg-ink-50">
          <SwatchImg
            color={color}
            px={GRID_TILE_PX}
            src={swatchSrc}
            fallbackSrc={swatchFallbackSrc}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        </span>
        <span className="block px-1 pt-0.5 pb-1">
          <span className="block truncate text-micro font-medium leading-tight text-ink-800">{color.name}</span>
          {color.code && <span className="block text-micro text-ink-500 tabular-nums">#{color.code}</span>}
        </span>
      </button>
      {active && (
        <span className="absolute right-1 top-1 grid place-items-center w-[18px] h-[18px] rounded-full bg-brand-600 text-white shadow-sm pointer-events-none">
          <Check size={11} strokeWidth={3} aria-hidden />
        </span>
      )}
    </div>
  );
}

/** The handlers that open and close the hover card, spread onto a tile.
 *
 *  Written once because the two levels must behave identically — a wall where
 *  hovering a tela does nothing and hovering a colour does something teaches
 *  the visitor that hovering is unreliable, which is worse than no hover at
 *  all. Returns nothing when there is no image to preview (a colour with no
 *  swatch anywhere), so an empty card can never open. */
function hoverPreviewProps(onPreview, preview) {
  if (!onPreview || !preview || !(preview.src || preview.fallback || preview.base)) return null;
  return {
    ...(FINE_POINTER ? {
      onMouseEnter: (e) => onPreview(e.currentTarget, preview),
      onMouseLeave: (e) => onPreview(e.currentTarget, null),
    } : null),
    onFocus: (e) => { if (keyboardFocused(e.currentTarget)) onPreview(e.currentTarget, preview); },
    onBlur: (e) => onPreview(e.currentTarget, null),
  };
}

/** A swatch cell: the LIGNE ROSET photo, and only if that host has nothing for
 *  this code, the colour's own scan — then the bare plate.
 *
 *  One component for both levels because the fallback is a STEP, not a url: an
 *  `onError` that hides the image (what both tiles did) turns a discontinued
 *  colour into a blank square, and a picker full of blank squares reads as a
 *  broken pane rather than as a catalogue that moved on. */
function SwatchImg({ color, px, src, fallbackSrc, className }) {
  const urls = useMemo(() => {
    const list = [src?.(color, px), fallbackSrc?.(color, px)].filter(Boolean);
    return list.filter((u, i) => list.indexOf(u) === i);
  }, [src, fallbackSrc, color, px]);
  const [step, setStep] = useState(0);
  const first = urls[0] || '';
  useEffect(() => { setStep(0); }, [first]);   // a new colour in the same cell tries again
  const url = urls[step];
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setStep((s) => s + 1)}
      className={className}
    />
  );
}

function Empty({ locale }) {
  return <div className="py-10 text-center text-xs text-ink-500">{t(locale, 'fabric.paneNoResults')}</div>;
}

/** `overlay` = the variant that sits ON a swatch (the level-1 tile): it has to
 *  read over ANY fabric photo, so it goes to the same black scrim the zoom
 *  affordance uses rather than the ink chip the header can afford. */
function GradeBadge({ grade, overlay = false }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-micro font-semibold uppercase tracking-wide ${
      overlay ? 'bg-black/55 text-white' : 'bg-ink-100 text-ink-600'
    }`}
    >
      Grade {grade}
    </span>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-micro font-medium transition-colors ${
        active
          ? 'bg-ink-900 border-ink-900 text-ink-50'
          : 'bg-surface border-ink-200 text-ink-600 hover:bg-ink-50 active:bg-ink-100'
      }`}
    >
      {children}
    </button>
  );
}
