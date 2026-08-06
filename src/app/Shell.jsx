import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { Boxes, Store, Inbox, ExternalLink, LogOut, Loader2, Hourglass, Tags, FileText, LayoutDashboard, Layers } from 'lucide-react';
import { AuthProvider, useAuth } from '../context/AuthContext.jsx';
import { AppProvider, useApp } from '../context/AppContext.jsx';
import { ConfirmProvider } from '../components/ConfirmProvider.jsx';
import { isPublicRoute } from '../lib/theme.js';
import { togoShareUrl } from '../lib/togoEmbed.js';
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
const TogoDealers = lazyPage(() => import('../pages/admin/TogoDealers.jsx'));
const TogoRequests = lazyPage(() => import('../pages/TogoRequests.jsx'));
const DealerInbox = lazyPage(() => import('../pages/DealerInbox.jsx'));
const Quotes = lazyPage(() => import('../pages/quoting/Quotes.jsx'));
const QuoteDetail = lazyPage(() => import('../pages/quoting/QuoteDetail.jsx'));
const RequestDetail = lazyPage(() => import('../pages/quoting/RequestDetail.jsx'));
const QuoteShare = lazyPage(() => import('../pages/quoting/QuoteShare.jsx'));

/**
 * The admin shell: five destinations and nothing else.
 *
 *   Modelos          — the 3D studio + model manager   (pages/admin/TogoCatalog)
 *   Distribuidores   — dealer records + install kits   (pages/admin/TogoDealers)
 *   Solicitudes      — leads out of the configurator   (pages/TogoRequests)
 *   Marcas           — the brand microenvironments     (pages/admin/Brands)
 *   Configurador     — opens the PUBLIC widget         (/configurator)
 *
 * EVERYTHING BELOW THE BRAND SWITCHER IS ONE BRAND'S ENVIRONMENT. The switcher
 * in the nav picks which manufacturer you are working in; the data layer filters
 * every read and stamps every write to it (db/brandScope.ts), so the three
 * destinations above need no brand plumbing of their own.
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
  { to: '/marcas', label: 'Marcas', icon: Tags },
  { to: '/kvadrat', label: 'Kvadrat', icon: Layers },
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
 * WHICH MANUFACTURER YOU ARE WORKING IN.
 *
 * It sits directly under the wordmark because it governs everything below it:
 * the models, the materials, the distribuidores and the solicitudes on every
 * page are that brand's, and switching re-scopes the whole app (AppContext →
 * db/brandScope). Real rows — the `brands` table, active brands first — never a
 * hardcoded list.
 *
 * One brand reads as a LABEL, not a control: a picker with a single option is a
 * question with one answer. No brands at all (a database the migration hasn't
 * reached yet) renders nothing, and the app runs exactly as it did before.
 */
function BrandSwitcher() {
  const { brands, brand, selectBrand } = useApp();
  const options = (brands || []).filter((b) => b.active !== false || b.id === brand?.id);
  if (!brand || !options.length) return null;
  const dot = brand.branding?.primaryColor || null;
  if (options.length === 1) {
    return (
      <div className="px-1 md:px-3 shrink-0 md:mb-3 flex items-center gap-2 max-w-[10rem] md:max-w-none">
        <BrandLogo brand={brand} size={18} tone="chrome" />
        <span className="sr-only">{brand.name}</span>
      </div>
    );
  }
  return (
    <div className="px-1 md:px-3 shrink-0 md:mb-3 flex items-center gap-2 md:block">
      <BrandLogo brand={brand} size={18} tone="chrome" className="md:mb-2" />
      <label className="sr-only" htmlFor="brand-switcher">Marca</label>
      <select
        id="brand-switcher"
        value={brand.id}
        onChange={(e) => selectBrand(e.target.value)}
        className="w-full cursor-pointer max-w-[11rem] md:max-w-none rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-xs font-medium text-ink-100 hover:border-ink-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors"
        title="Marca activa — sus modelos, materiales, distribuidores y solicitudes"
      >
        {options.map((b) => (
          <option key={b.id} value={b.id}>{b.name}{b.active === false ? ' (inactiva)' : ''}</option>
        ))}
      </select>
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

      <BrandSwitcher />

      {NAV.map((item) => <NavItem key={item.to} {...item} />)}

      <a
        href={togoShareUrl()}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink-300 hover:bg-ink-800/60 hover:text-ink-50 transition-colors whitespace-nowrap"
        title="Abrir el configurador público"
      >
        <ExternalLink size={16} aria-hidden />
        Configurador
      </a>

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
            <Route path="kvadrat" element={<KvadratImport />} />
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
