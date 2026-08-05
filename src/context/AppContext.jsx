import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { db, ensureDefaultProfile, getSettings, updateSettings, invalidate } from '../db/database.js';
import { setBrandScope } from '../db/brandScope.js';
import { supabase } from '../db/supabaseClient.js';
import { shouldPullSessionRate } from '../lib/exchangeRate.js';
import { EXCHANGE_RATE_PULL_ENABLED } from '../lib/constants.js';
import { moduleSetFor, setActiveModules } from '../brands/index.js';
import useLocalPref from '../components/primitives/useLocalPref.js';
import { useAuth } from './AuthContext.jsx';

const Ctx = createContext(null);

/** Where the device remembers which brand environment you were working in. */
const BRAND_PREF_KEY = 'veta.brand.v1';

/**
 * Read every brand, by name — the order the switcher offers them in.
 * Best-effort BY DESIGN: on a
 * database the brands migration hasn't reached yet the table simply isn't there,
 * and the honest answer is "no brands" — which leaves the scope unset and every
 * query behaving exactly as it did before brands existed, rather than taking the
 * whole app down over a deploy-window ordering.
 */
async function loadBrands() {
  try {
    return await db.brands.orderBy('name').toArray();
  } catch (e) {
    console.warn('[brands] not available yet:', e?.message || e);
    return null;
  }
}

/**
 * WHICH BRAND IS OPEN. The remembered one when it still exists and is active,
 * otherwise the first active brand, otherwise the first brand at all (an
 * all-inactive install must still be reachable — that is where you go to
 * re-activate one). null when there are no brands: an unscoped app.
 */
export function pickActiveBrand(brands, preferredId) {
  const list = brands || [];
  if (!list.length) return null;
  const preferred = list.find((b) => b.id === preferredId);
  if (preferred && preferred.active !== false) return preferred;
  return list.find((b) => b.active !== false) || list[0];
}

/**
 * App-level context. The team is still single-tenant (one shared 'team'
 * profile holds company-wide settings) but each signed-in user now has
 * a per-user profile row with role + commission. This context exposes:
 *
 *   profileId        — the shared 'team' id (kept stable; existing
 *                      `db.X.where('profileId').equals(profileId)` calls
 *                      across the app continue to work unchanged)
 *   profiles         — every profile row (team + each user); used by
 *                      the admin Users page
 *   currentProfile   — the *signed-in user's* profile row, with role,
 *                      commission_pct, active. Pages gate features off
 *                      this (admin-only routes, etc.)
 *   settings         — the team settings row
 *
 * The shared 'team' row carries `admin_emails` (jsonb array of lowercase
 * email strings). On first sign-in, any user whose email matches that
 * list is auto-promoted to role='admin' + active=true. Everyone else
 * starts inactive and must be approved by an admin via the Users page.
 */
export function AppProvider({ children }) {
  const { user } = useAuth();
  const [profileId, setProfileId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [currentProfile, setCurrentProfile] = useState(null);
  // Admin-only "view as" preview. When an admin picks a non-admin role
  // here, the whole UI re-gates as if they had that role (sidebar nav,
  // per-page access, in-quote controls) WITHOUT touching their real
  // identity or server privileges — see the effectiveProfile derivation
  // below. Held in memory only: a reload or sign-out drops them back to
  // their real admin view, so they can never get stranded in a role.
  const [viewAsRole, setViewAsRoleState] = useState(null);
  const [ready, setReady] = useState(false);

  // ── THE BRAND MICROENVIRONMENT ────────────────────────────────────────────
  // Every manufacturer is an isolated environment (models, materials, telas,
  // distribuidores, solicitudes) with its own IMPORT MODULES. The choice is
  // device-local (which brand you were last working in is a preference, not
  // company data) and is installed into the DATA LAYER — `setBrandScope` — so
  // every read is filtered and every write stamped one level below the call
  // sites. See db/brandScope.ts for why it lives there and not in each page.
  const [brands, setBrands] = useState([]);
  const [brandsAvailable, setBrandsAvailable] = useState(false);
  const [brandId, setBrandIdPref] = useLocalPref(BRAND_PREF_KEY, null);

  const refreshProfiles = useCallback(async () => {
    const list = await db.profiles.toArray();
    setProfiles(list);
    return list;
  }, []);

  /** Re-read the brand list. Called at boot and by the Marcas admin after every
   *  write, so the selector and the scope follow a rename/deactivation
   *  immediately. Deliberately NOT a live query: the scope has to be installed
   *  before the pages that depend on it render. */
  const refreshBrands = useCallback(async () => {
    const list = await loadBrands();
    setBrands(list || []);
    setBrandsAvailable(!!list);
    return list || [];
  }, []);

  const refreshSettings = useCallback(async (pid) => {
    const target = pid || profileId;
    if (!target) return null;
    const s = await getSettings(target);
    setSettings(s);
    return s;
  }, [profileId]);

  // Re-read the signed-in user's profile from the list. Called after
  // any write that could change the current user's role/active state
  // (e.g. an admin demoting themselves — defensive, the UI blocks it
  // but the contract is "any write triggers a refresh").
  const refreshCurrentProfile = useCallback(async () => {
    if (!user?.id) {
      setCurrentProfile(null);
      return null;
    }
    const p = await db.profiles.get(user.id);
    setCurrentProfile(p || null);
    return p || null;
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pid = await ensureDefaultProfile();
        if (cancelled) return;
        setProfileId(pid);

        const s = await getSettings(pid);
        if (cancelled) return;
        setSettings(s);

        // Instant-refresh + cron bootstrap for the BPD exchange rate. The
        // RELIABLE pull is the server-side hourly cron (migration
        // *_bpd_rate_cron_hourly); this browser pull just lands the figure
        // immediately for an open session and arms the cron on a fresh deploy.
        // The Edge Function persists the rate and we re-read it once it lands.
        // A short throttle (shouldPullSessionRate) keeps rapid reloads from
        // hammering the bank. Fire-and-forget — it must never block app
        // readiness or fail the boot if the bank is down.
        // Gated off until production (EXCHANGE_RATE_PULL_ENABLED); the stored
        // rate and the manual override in Settings stay in effect.
        if (EXCHANGE_RATE_PULL_ENABLED && shouldPullSessionRate(s)) {
          supabase.functions
            .invoke('bpd-rate')
            .then(async ({ error }) => {
              if (error || cancelled) return;
              const fresh = await getSettings(pid);
              if (!cancelled) setSettings(fresh);
            })
            .catch(() => {});
        }

        // (A cold-quote sweep used to run here, inherited from the app this one
        // was extracted from. It read `db.quotes` — the ERP's quote table, which
        // does not exist in this database — so every boot fired a request that
        // 404'd into a swallowed catch. It could never have worked here anyway:
        // a veta quote is a FROZEN document, RLS grants the browser no write on
        // it at all, and its lifecycle is the Edge Function's. Removed rather
        // than repointed — there is no archive state to sweep it into.)

        const list = await refreshProfiles();
        if (cancelled) return;

        // Load the current user's profile from what we just fetched
        // (no extra round-trip).
        const me = user?.id ? list.find((p) => p.id === user.id) : null;
        if (!cancelled) setCurrentProfile(me || null);

        // The brand environments, BEFORE the app is declared ready: the scope
        // is installed during this provider's render (below), so the first
        // query any page fires is already filtered to the open brand.
        await refreshBrands();
        if (cancelled) return;

        setReady(true);
      } catch (e) {
        console.error('AppContext init failed:', e);
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshProfiles, refreshBrands, user?.id]);

  // ── The open brand, and the data-layer scope that follows it ──────────────
  const brand = useMemo(() => pickActiveBrand(brands, brandId), [brands, brandId]);
  const brandModules = useMemo(() => moduleSetFor(brand), [brand]);

  // Installed DURING RENDER, not in an effect: the scope is external store
  // state that every child's very first query reads, and an effect would run
  // after those children had already fetched — one paint of the previous
  // brand's rows on every switch. It is idempotent (setBrandScope answers
  // false when nothing changed), so a double-invoked render costs nothing.
  const scopeChanged = useRef(false);
  if (setBrandScope(brand ? { brandId: brand.id, catalogBrand: brand.settings?.catalogBrand || brand.slug || null } : null)) {
    scopeChanged.current = true;
  }
  // The MODULE SET rides the same seam, for the same reason: the SKU grammar,
  // the grade ladder and the swatch source are read from leaf call sites that
  // never hold a brand (lib/catalog · lib/subtype · lib/swatchImage), so they
  // ask brands/runtime for the open brand's adapters. Installed during render
  // too — a component that resolves a SKU on its first paint must not read the
  // previous brand's grammar. `moduleSetFor` never returns null, so this is
  // always a real set (the registry's Ligne Roset fallback when a brand names
  // nothing usable), which is exactly what the app did before brands existed.
  setActiveModules(brandModules);
  // The refetch belongs AFTER the commit — invalidate() notifies every live
  // query, and doing that mid-render would set state in other components while
  // this one is still rendering. It fires on EVERY change including the first
  // install: the boot case costs one duplicate read of two small tables, while
  // the case it covers — the very first brand being created in a session that
  // has already read unscoped rows — would otherwise leave those rows on
  // screen until the next mutation.
  useEffect(() => {
    if (!scopeChanged.current) return;
    scopeChanged.current = false;
    invalidate();
  });

  /** Switch environment. The preference is device-local; the scope + refetch
   *  ride the render above, so every open page repaints on the new brand. */
  const selectBrand = useCallback((id) => {
    setBrandIdPref(id || null);
  }, [setBrandIdPref]);

  // Realtime: subscribe to public.profiles so changes made in another
  // session land here without a manual refresh. Admin A deleting user
  // B from one browser tab now removes the row from admin C's open
  // /admin/users page within ~1 s — previously C would see a ghost
  // until a hard reload. Migration 20260518160000 adds the profiles
  // table to the supabase_realtime publication; without that, the
  // channel here subscribes successfully but never receives events.
  //
  // The handler re-runs every refresh path: profiles list, current
  // user's row, AND the global `invalidate()` bus that backs
  // useLiveQuery — so any page rendering profile-derived data
  // refetches together. We don't try to debounce or deduplicate
  // against local writes; a second refetch after a local mutation is
  // cheap and keeps the state machine simple.
  useEffect(() => {
    if (!user?.id) return undefined;
    const channel = supabase
      .channel('rt:public:profiles')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        async () => {
          await refreshProfiles();
          await refreshCurrentProfile();
          invalidate();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refreshProfiles, refreshCurrentProfile]);

  // Realtime: the team settings row (exchange rate, company info) is
  // shared and changes from other sessions — the daily rate pull, the
  // "Actualizar ahora" button, or another admin editing settings. Without
  // a live channel an open session kept a stale cached rate until reload,
  // so a freshly pulled rate never reached quote panes already on screen.
  // Migration 20260520140000 adds settings to the supabase_realtime
  // publication; we re-read on any change so the rate (and everything
  // settings-derived) updates everywhere at once — one source of truth.
  useEffect(() => {
    if (!user?.id) return undefined;
    const channel = supabase
      .channel('rt:public:settings')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settings' },
        async () => {
          await refreshSettings();
          invalidate();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refreshSettings]);

  const saveSettings = useCallback(async (patch) => {
    await updateSettings(profileId, patch);
    await refreshSettings();
  }, [profileId, refreshSettings]);

  // "View as" preview (admin only). We override ONLY the role on the
  // exposed profile, so every existing consumer — the sidebar nav, the
  // per-page `isAdmin` gates, the in-quote seller picker — re-renders as
  // that role with zero changes on their side. Identity (id, email,
  // active, passwordSetAt) keeps the admin's real values, so data writes,
  // commission attribution, and the App-level Gate stay untouched, and
  // RLS on the server still sees the real admin. The override is honored
  // only when the *real* role is admin, so it can never be an escalation.
  const realRole = currentProfile?.role || null;
  const canViewAs = realRole === 'admin';
  const effectiveRole = canViewAs && viewAsRole ? viewAsRole : realRole;

  const setViewAsRole = useCallback((role) => {
    setViewAsRoleState(role === 'employee' || role === 'accounting' ? role : null);
  }, []);

  // Defensive: if this user ever stops being an admin (e.g. another admin
  // demotes them and the realtime profiles channel lands), drop any active
  // preview so they fall straight back to their real role's view.
  useEffect(() => {
    if (realRole !== 'admin' && viewAsRole) setViewAsRoleState(null);
  }, [realRole, viewAsRole]);

  const effectiveProfile = useMemo(
    () =>
      currentProfile && effectiveRole !== currentProfile.role
        ? { ...currentProfile, role: effectiveRole }
        : currentProfile,
    [currentProfile, effectiveRole],
  );

  const value = {
    ready,
    profileId,
    profiles,
    settings,
    // ── Brand microenvironment ──────────────────────────────────────────────
    /** Every brand row (empty on a database the migration hasn't reached). */
    brands,
    /** False = no `brands` table yet; the app runs unscoped, exactly as before. */
    brandsAvailable,
    /** The OPEN brand's row, or null when there are none. */
    brand,
    brandId: brand?.id || null,
    /** Its resolved import-module set — geometry / materials / catalog. */
    brandModules,
    selectBrand,
    refreshBrands,
    // The role-overridden projection — what the app gates its UI off.
    currentProfile: effectiveProfile,
    // The untouched signed-in profile, for anything that needs the real
    // role regardless of the preview (e.g. gating the toggle itself).
    realProfile: currentProfile,
    realRole,
    isAdmin: effectiveRole === 'admin',
    isAccounting: effectiveRole === 'accounting',
    isActive: !!currentProfile?.active,
    // Admin "view as" preview controls.
    canViewAs,
    viewAsRole: canViewAs ? viewAsRole : null,
    setViewAsRole,
    refreshProfiles,
    refreshSettings,
    refreshCurrentProfile,
    saveSettings,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
