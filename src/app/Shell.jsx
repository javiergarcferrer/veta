import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { Boxes, Store, Inbox, ExternalLink, LogOut, Loader2, Hourglass, Settings2, FileText, LayoutDashboard, Layers, Armchair, BookOpen, Sofa } from 'lucide-react';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import { AppProvider, useApp } from '../context/AppContext.jsx';
import { ConfirmProvider } from '../components/ConfirmProvider.jsx';
import { isPublicRoute } from '../lib/theme.js';
import { togoShareUrl } from '../lib/togoEmbed.js';
import { CONFIGURATORS, configuratorPath } from '../brands/configurators/index.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import SignIn from './SignIn.jsx';

// Every destination is code-split, and ALWAYS through safeDynamicImport: a raw
// import() strands stale-deploy users on "failed to fetch dynamically imported
// module"; the helper retries and recovers. It also keeps the public
// distributor inbox from dragging the model studio down with it.
const lazyPage = (loader) => lazy(() => safeDynamicImport(loader));
import BrandLogo from '../components/BrandLogo.jsx';

const Dashboard = lazyPage(() => import('../pages/Dashboard.jsx'));
const TogoCatalog = lazyPage(() => import('../pages/admin/TogoCatalog.jsx'));
const Brands = lazyPage(() => import('../pages/admin/Brands.jsx'));
const KvadratImport = lazyPage(() => import('../pages/admin/KvadratImport.jsx'));
const FredericiaImport = lazyPage(() => import('../pages/admin/FredericiaImport.jsx'));
const LigneRosetImport = lazyPage(() => import('../pages/admin/LigneRosetImport.jsx'));
const CarlHansenImport = lazyPage(() => import('../pages/admin/CarlHansen.jsx'));
const TogoDealers = lazyPage(() => import('../pages/admin/TogoDealers.jsx'));
const TogoRequests = lazyPage(() => import('../pages/TogoRequests.jsx'));
const DealerInbox = lazyPage(() => import('../pages/DealerInbox.jsx'));
const Quotes = lazyPage(() => import('../pages/quoting/Quotes.jsx'));
const QuoteDetail = lazyPage(() => import('../pages/quoting/QuoteDetail.jsx'));
const RequestDetail = lazyPage(() => import('../pages/quoting/RequestDetail.jsx'));
const QuoteShare = lazyPage(() => import('../pages/quoting/QuoteShare.jsx'));

/**
 * The admin shell. Three regions, top to bottom, and only the FIRST one carries
 * a brand's identity:
 *
 * 1. VETA — the wordmark. The app's ONLY identity: no brand's logo ever sits
 *    here, because a mark in the masthead reads as "whose app this is", and
 *    this app belongs to no manufacturer.
 * 2. MARCAS — the brand rail (BrandRail): one visible row per brand, the open
 *    one highlighted. A row selects that brand's whole environment, and a
 *    brand with a registered configurator carries its own ↗ launcher
 *    (brands/configurators — Togo owns the bare /configurador; every other
 *    brand gets its suffixed path). The rail's gear opens «Marcas», where
 *    brands are created and dressed. EVERYTHING BELOW THE RAIL IS ONE BRAND'S
 *    ENVIRONMENT — the data layer filters every read and stamps every write to
 *    the open brand (db/brandScope.ts), so the destinations need no brand
 *    plumbing of their own:
 *
 *      Panel            — the open brand's numbers          (pages/Dashboard)
 *      Modelos          — the 3D studio + model manager (pages/admin/TogoCatalog)
 *      Distribuidores   — dealer records + install kits (pages/admin/TogoDealers)
 *      Solicitudes      — leads out of the configurator (pages/TogoRequests)
 *      Cotizaciones     — the frozen quote documents    (pages/quoting/Quotes)
 *
 * 3. IMPORTAR — one destination per SUPPLIER SOURCE: a house that publishes its
 *    own library online, a link to paste rather than a folder to drop. They are
 *    labelled by the SOURCE, deliberately apart from the brand rail — «Fredericia
 *    · Anthom» is the distributor's storefront that FILLS the Fredericia brand,
 *    not the brand itself, and the two reading as one thing is exactly the
 *    confusion this section exists to end:
 *
 *      Ligne Roset · Étiquette — the manufacturer's OFFICIAL feed → catálogo,
 *                            telas, bajas y dibujos (pages/admin/LigneRosetImport)
 *      Kvadrat            — a colourway collection → telas (pages/admin/KvadratImport)
 *      Fredericia · Anthom — Anthom's storefront → catálogo (pages/admin/FredericiaImport)
 *      Carl Hansen · PIM  — the manufacturer's public PIM → sweep, configure,
 *                            mint products at list price (pages/admin/CarlHansen)
 *
 * Two surfaces skip authentication entirely, because they are the product's
 * public half: the clean `/configurator` URLs (mounted before this file ever
 * loads — see main.jsx) and the token-gated distributor inbox
 * `#/dealer/:token`, whose token IS the authorization.
 */

const NAV = [
  // `end` or the home link stays permanently active on every child route.
  { to: '/', label: 'Panel', icon: LayoutDashboard, end: true },
  { to: '/modelos', label: 'Modelos', icon: Boxes },
  { to: '/distribuidores', label: 'Distribuidores', icon: Store },
  { to: '/solicitudes', label: 'Solicitudes', icon: Inbox },
  { to: '/cotizaciones', label: 'Cotizaciones', icon: FileText },
];

const IMPORT_NAV = [
  { to: '/ligne-roset', label: 'Ligne Roset · Étiquette', icon: BookOpen },
  { to: '/kvadrat', label: 'Kvadrat', icon: Layers },
  { to: '/fredericia', label: 'Fredericia · Anthom', icon: Armchair },
  { to: '/carl-hansen', label: 'Carl Hansen · PIM', icon: Sofa },
];

function Loading({ label = 'Cargando…' }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-500">
      <Loader2 size={20} className="animate-spin" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Mirror the boot script's `is-public` flag onto <html> on every navigation —
 *  isPublicRoute() reads location.hash, so the distributor inbox keeps text
 *  selection enabled (index.css) while the admin app stays unselectable. */
function PublicRouteBodyClass() {
  const location = useLocation();
  useEffect(() => {
    document.documentElement.classList.toggle('is-public', isPublicRoute());
  }, [location.pathname, location.hash]);
  return null;
}

function NavItem({ to, label, icon: Icon, onNavigate, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
          isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
        }`
      }
    >
      <Icon size={16} aria-hidden />
      {label}
    </NavLink>
  );
}

/**
 * ONE BRAND'S ROW ON THE RAIL. The row body selects that brand's environment;
 * the ↗ — present only when the registry knows a configurator for this brand —
 * opens the brand's OWN configurator in a new tab. Togo's rides togoShareUrl()
 * (the bare path, with its link-preview version pin); every other brand's is
 * its registered suffixed path, which the Vercel rewrite already serves.
 */
function BrandRow({ b, active, onSelect }) {
  const configurator = CONFIGURATORS.find((c) => c.brandSlug === b.slug) || null;
  const href = configurator
    ? (configurator.slug ? `${location.origin}${configuratorPath(configurator)}` : togoShareUrl())
    : null;
  return (
    <div
      className={`group flex items-center rounded-lg transition-colors shrink-0 ${
        active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        title={`Trabajar en ${b.name}`}
        className={`flex-1 min-w-0 inline-flex items-center gap-2 pl-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
          href ? 'pr-1' : 'pr-3'
        } ${active ? 'text-ink-50' : 'text-ink-300 group-hover:text-ink-50'}`}
      >
        <BrandLogo brand={b} size={16} tone="chrome" />
        <span className="hidden md:inline truncate">
          {b.name}
          {b.active === false ? ' (inactiva)' : ''}
        </span>
        <span className="sr-only md:hidden">{b.name}</span>
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={`${configurator.label} — abrir en una pestaña nueva`}
          className={`px-2 py-2 shrink-0 rounded-lg transition-colors ${
            active ? 'text-ink-300 hover:text-ink-50' : 'text-ink-500 hover:text-ink-50'
          }`}
        >
          <ExternalLink size={14} aria-hidden />
          <span className="sr-only">Abrir {configurator.label}</span>
        </a>
      )}
    </div>
  );
}

/**
 * THE BRAND RAIL — which manufacturer you are working in, as a VISIBLE list.
 *
 * It sits directly under the wordmark because it governs everything below it:
 * the models, materials, distribuidores and solicitudes on every page are the
 * highlighted brand's, and selecting a row re-scopes the whole app (AppContext
 * → db/brandScope). Real rows — the `brands` table — never a hardcoded list.
 *
 * A RAIL, not a <select>: the dropdown hid the brands behind a click and wore
 * the open brand's logo directly under the wordmark, where it read as the
 * app's own identity. Here every brand is on screen at once, the house brand
 * first (`is_house`, seeding order as the tiebreak), each with its own
 * configurator launcher — siloed side by side instead of stacked behind a
 * control. No brands at all (a database the migration hasn't reached yet)
 * renders nothing, and the app runs exactly as it did before.
 */
function BrandRail() {
  const { brands, brand, selectBrand } = useApp();
  const options = (brands || []).filter((b) => b.active !== false || b.id === brand?.id);
  if (!brand || !options.length) return null;
  const rail = [...options].sort(
    (a, b) =>
      (b.isHouse === true) - (a.isHouse === true)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.name || '').localeCompare(String(b.name || '')),
  );
  return (
    <div className="shrink-0 md:mb-2 flex items-center gap-1 md:block md:space-y-0.5">
      <div className="flex items-center gap-1 md:justify-between md:px-3 md:pb-1">
        <span className="hidden md:inline text-[11px] font-medium uppercase tracking-wider text-ink-500">
          Marcas
        </span>
        <NavLink
          to="/marcas"
          title="Administrar marcas"
          className={({ isActive }) =>
            `inline-flex items-center rounded-lg p-1.5 transition-colors ${
              isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-500 hover:bg-ink-800/60 hover:text-ink-50'
            }`
          }
        >
          <Settings2 size={14} aria-hidden />
          <span className="sr-only">Administrar marcas</span>
        </NavLink>
      </div>
      {rail.map((b) => (
        <BrandRow key={b.id} b={b} active={b.id === brand.id} onSelect={() => selectBrand(b.id)} />
      ))}
    </div>
  );
}

/** A quiet group caption in the chrome — hidden on the mobile strip, where the
 *  items themselves have to carry the meaning. */
function NavSection({ label }) {
  return (
    <div className="hidden md:block px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-500">
      {label}
    </div>
  );
}

/** Top/side navigation. Always-dark chrome (`.theme-chrome` re-pins the ink
 *  ramp to the light values locally), matching the app's own convention. */
function Nav() {
  const { signOut } = useAuth();
  const { currentProfile } = useApp();
  return (
    <nav className="theme-chrome bg-ink-900 text-ink-100 md:w-56 md:shrink-0 md:h-full md:flex md:flex-col px-3 py-3 md:py-5 gap-3 md:gap-1 flex items-center md:items-stretch overflow-x-auto md:overflow-x-visible pt-safe-area md:pl-safe-area">
      <div className="font-wordmark text-lg tracking-[0.18em] px-1 md:px-3 md:mb-2 shrink-0">VETA</div>

      <BrandRail />

      {NAV.map((item) => <NavItem key={item.to} {...item} />)}

      <NavSection label="Importar" />
      {IMPORT_NAV.map((item) => <NavItem key={item.to} {...item} />)}

      <div className="md:mt-auto md:pt-4 flex items-center gap-2 md:flex-col md:items-stretch">
        {currentProfile?.email && (
          <div className="hidden md:block px-3 text-[11px] text-ink-400 truncate" title={currentProfile.email}>
            {currentProfile.email}
          </div>
        )}
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink-300 hover:bg-ink-800/60 hover:text-ink-50 transition-colors whitespace-nowrap"
        >
          <LogOut size={16} aria-hidden />
          Salir
        </button>
      </div>
    </nav>
  );
}

function NotFound() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="font-display text-lg font-semibold">Esta página no existe</div>
      <p className="text-sm text-ink-500 max-w-md">
        La ruta que abriste no forma parte de esta aplicación.
      </p>
      <NavLink to="/modelos" className="btn-primary text-sm">Ir a Modelos</NavLink>
    </div>
  );
}

/** Signed in: everything below needs the team profile + settings, so it hangs
 *  off AppProvider. */
function AdminApp() {
  const { ready, currentProfile, isActive } = useApp();
  const { user, signOut } = useAuth();

  if (!ready) return <Loading />;

  // Signed in with a valid JWT but no backing profile row (deleted while
  // signed in): every query would be denied by RLS, so bounce them out.
  if (user && !currentProfile) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-4">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 inline-flex items-center justify-center">
          <Hourglass size={22} aria-hidden />
        </div>
        <div>
          <div className="text-lg font-semibold">Sesión no válida</div>
          <p className="text-sm text-ink-500 max-w-md mt-1">
            Tu cuenta ya no existe o fue eliminada. Cierra sesión para volver a la pantalla de inicio.
          </p>
        </div>
        <button type="button" onClick={signOut} className="btn-primary text-sm" autoFocus>
          <LogOut size={14} aria-hidden /> Cerrar sesión
        </button>
      </div>
    );
  }

  // Authenticated but not activated by an admin yet.
  if (!isActive) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-4">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 inline-flex items-center justify-center">
          <Hourglass size={22} aria-hidden />
        </div>
        <div>
          <div className="text-lg font-semibold">Cuenta pendiente de activación</div>
          <p className="text-sm text-ink-500 max-w-md mt-1">
            Un administrador debe habilitar tu acceso. Vuelve a intentarlo más tarde.
          </p>
          <p className="text-xs text-ink-400 mt-3">
            Conectado como <b className="text-ink-700">{user?.email}</b>.
          </p>
        </div>
        <button type="button" onClick={signOut} className="btn-secondary text-sm">
          <LogOut size={14} aria-hidden /> Cerrar sesión
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col md:flex-row bg-canvas">
      <Nav />
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto px-4 py-5 md:px-8 md:py-7 pb-safe-area">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="modelos" element={<TogoCatalog />} />
            <Route path="distribuidores" element={<TogoDealers />} />
            <Route path="solicitudes" element={<TogoRequests />} />
            <Route path="solicitudes/:id" element={<RequestDetail />} />
            <Route path="cotizaciones" element={<Quotes />} />
            <Route path="cotizaciones/:id" element={<QuoteDetail />} />
            <Route path="marcas" element={<Brands />} />
            <Route path="ligne-roset" element={<LigneRosetImport />} />
            <Route path="carl-hansen" element={<CarlHansenImport />} />
            <Route path="kvadrat" element={<KvadratImport />} />
            <Route path="fredericia" element={<FredericiaImport />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/** The auth gate. Public routes never get here (they're matched first below). */
function AuthedArea() {
  const { ready, user } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <SignIn />;
  return (
    <AppProvider>
      <AdminApp />
    </AppProvider>
  );
}

export default function Shell() {
  return (
    <AuthProvider>
      <ConfirmProvider>
        <PublicRouteBodyClass />
        <Routes>
          {/* Login-less, token-gated distributor inbox — the token IS the
              authorization, so it mounts outside the auth gate. */}
          <Route
            path="/dealer/:token"
            element={<Suspense fallback={<Loading />}><DealerInbox /></Suspense>}
          />
          {/* The customer's own quote link — token-gated, no account. */}
          <Route
            path="/q/:token"
            element={<Suspense fallback={<Loading />}><QuoteShare /></Suspense>}
          />
          <Route path="/*" element={<AuthedArea />} />
        </Routes>
      </ConfirmProvider>
    </AuthProvider>
  );
}
