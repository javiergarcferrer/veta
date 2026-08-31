// togo-match — Claude PICKS the SKU that prices an uploaded model. Brand-agnostic
// by construction: it only ever ranks the shortlist the browser already narrowed
// (lib/configurator/modelMatch), so it never needs to know whose catalog that came from.
// (or one of its componentes) from a shortlist the browser already narrowed.
//
// The division of labour is the whole design: `src/lib/configurator/modelMatch.js` runs
// in the browser (which already holds the 27k-row catalog lazily) and hands over
// at most MAX_CANDIDATES roots that could legitimately price the piece; this
// function decides among exactly those. Claude is not a second ranker — it reads
// the LR library's French/English naming against the catalog's English, which is
// the signal no arithmetic recovers ("gd canapé accoudoir A" ↔ "W/ ARMREST A").
//
// It SUGGESTS and never writes. No db mutation of any kind — exactly like
// wa-draft suggests replies: the dealer reviews the pick, sees the price
// difference against the alternatives, and binds it himself with one click.
//
// Why a function (not a direct browser call): the Anthropic key is a write-only
// secret (claude_config, service-role read) and must never reach the bundle. The
// caller's JWT is verified here so anonymous traffic can't drain the API spend.
//
// THE MONEY GUARD is in infer.ts (`resolveMatchAnswer`) and it is why this file
// is thin: a root Claude names that nobody offered is refused with 422, never
// passed through — `productRoot` IS the price of every quote the piece will ever
// appear in. A malformed answer or an API outage is a different failure with a
// different remedy: it degrades to the deterministic top candidate at
// confidence 'baja' with a note, so the dealer never loses the work.
//
// TWO OPS, ONE FUNCTION. `op:'collection'` maps a WHOLE family in one call
// (fifty independent picks can hand one root to two pieces and leave a third
// unused — only the batch can see that), and it EXTENDS this path rather than
// forking it: same auth, same key read, same model, same degrade, and the
// prompt vocabulary + candidate validator are literally shared in infer.ts. Its
// one structural difference lives in `runCollection`: it never 422s, because
// refusing one bad row there would cost the other 49 pieces their suggestion.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk';

// VETA is a single-install deploy: the config row lives under 'team', same as
// every sibling function. Upstream reads this from _shared/tenant.ts and also
// meters token usage (_shared/usage.ts) into its cost dashboard — both stay
// there by design; veta has neither tenants nor that dashboard.
const DEFAULT_TENANT = 'team';

import {
  parseMatchRequest,
  buildMatchPrompt,
  resolveMatchAnswer,
  fallbackSuggestion,
  parseCollectionRequest,
  buildCollectionPrompt,
  resolveCollectionAnswer,
  fallbackCollectionAnswer,
  parseDecomposeRequest,
  buildDecomposePrompt,
  resolveDecomposeAnswer,
  fallbackDecomposeAnswer,
} from './infer.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// Deliberately NOT the dealer's configured chat model (claude_config.model,
// which claude-chat reads): that one is tuned for the JARVIS conversation and
// may be a Haiku-class model. This is a money decision over catalog naming made
// once per binding — it takes the frontier model, and `medium` effort keeps the
// dealer from waiting on a pick among six rows.
const MATCH_MODEL = 'claude-opus-5';
// On Opus 5 thinking is ON by default and max_tokens caps thinking AND reply
// TOGETHER (the gasto-extract lesson): 2048 let a think-heavy match truncate
// its JSON and silently degrade to the deterministic fallback. Unspent tokens
// are free — size for the worst case, same as the collection path below.
const MAX_TOKENS = 16384;
// A whole collection answers for up to 40 pieces in one object, each with its
// own «por qué». 2048 would truncate the tail of the batch into unreadable
// JSON — which degrades everything to the deterministic mapping for no reason.
const COLLECTION_MAX_TOKENS = 16384;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ ok: false, error: 'Authorization header required' }, 401);
  }
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid or expired session' }, 401);

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* handled by the validator below — an unreadable body is just an empty one */
  }

  // Hoisted out of the key closure so the cost meter can share it — building a
  // second service-role client just to record tokens would be wasteful.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // SECURITY (H3): reject deactivated accounts — their JWT may still be valid
  const { data: activeProf } = await admin.from('profiles').select('active').eq('id', userData.user.id).maybeSingle();
  if (!activeProf || activeProf.active !== true) return json({ ok: false, error: 'Cuenta desactivada.' }, 403);

  // The key lives in the write-only claude_config table; only this service-role
  // read ever sees it. Read LAZILY so a half-typed payload still 400s before
  // costing a query — and so both ops share exactly one way of getting it.
  const apiKey = async (): Promise<string> => {
    const { data } = await admin
      .from('claude_config')
      .select('api_key')
      .eq('profile_id', DEFAULT_TENANT)
      .maybeSingle();
    return data?.api_key || '';
  };

  // ONE function, three ops sharing the prompt vocabulary and the degrade.
  // `collection` maps a WHOLE family in one call; `decompose` fills the
  // component SLOTS (parts.roots) from the shared cushion roots; the default
  // (no op) is the single-piece path, unchanged.
  const op = (body && typeof body === 'object' ? (body as Record<string, unknown>).op : null);
  if (op === 'collection') return await runCollection(body, apiKey, admin);
  if (op === 'decompose') return await runDecompose(body, apiKey, admin);
  return await runSingle(body, apiKey, admin);
});

/** The single-piece path: one shortlist in, one pick out. */
async function runSingle(
  body: unknown, apiKey: () => Promise<string>, admin: ReturnType<typeof createClient>,
): Promise<Response> {
  const parsed = parseMatchRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const request = parsed.req;

  // No key is a config problem the dealer must fix — but the shortlist is
  // already computed, so it degrades instead of erroring out.
  const key = await apiKey();
  if (!key) {
    return json({
      ok: true,
      configured: false,
      degraded: true,
      suggestion: fallbackSuggestion(request, 'Sin llave API de Anthropic — esta es la mejor coincidencia del cálculo.'),
    });
  }

  const { system, user } = buildMatchPrompt(request);
  const asked = await askClaude(key, system, user, MAX_TOKENS);
  if (!asked.ok) {
    // An outage is survivable; losing the shortlist the dealer waited for is not.
    return json({
      ok: true,
      degraded: true,
      model: asked.model,
      suggestion: fallbackSuggestion(request, asked.note),
    });
  }

  const answer = resolveMatchAnswer(request, asked.text);
  if (answer.ok) return json({ ok: true, model: asked.model, suggestion: answer.suggestion });

  // A root nobody offered is a hallucinated reference. It is REFUSED, not
  // silently swapped for our own pick: the dealer must never be shown a price
  // attributed to a decision that was never made.
  if (answer.kind === 'invented') {
    return json({
      ok: false,
      code: 'root_not_offered',
      root: answer.root,
      error: `La respuesta propuso una referencia (${answer.root}) que no estaba entre los candidatos.`,
    }, 422);
  }

  return json({
    ok: true,
    degraded: true,
    model: asked.model,
    suggestion: fallbackSuggestion(request, 'No se pudo leer la respuesta del asistente.'),
  });
}

/**
 * The COLLECTION path: a whole family mapped in one call.
 *
 * It never 422s and never 500s. The single path refuses an invented root because
 * refusing the one answer IS the outcome there; here the same refusal would cost
 * the other 49 pieces their suggestion, so an invalid row is dropped inside
 * `resolveCollectionAnswer` and REPORTED in `dropped` + `log`. Everything that
 * would have been an error is a degrade to the deterministic mapping instead —
 * the dealer waited for a batch and always gets a batch, labelled for what it is.
 */
async function runCollection(
  body: unknown, apiKey: () => Promise<string>, admin: ReturnType<typeof createClient>,
): Promise<Response> {
  const parsed = parseCollectionRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const request = parsed.req;
  // What the VALIDATOR already clamped travels with every reply, degraded or
  // not: a batch that quietly shrank is a batch the reviewer never audits.
  const degrade = (note: string, model?: string) => {
    const answer = fallbackCollectionAnswer(request, note);
    return json({ ok: true, degraded: true, ...(model ? { model } : {}), ...answer, log: [...parsed.log, ...answer.log] });
  };

  const key = await apiKey();
  if (!key) return degrade('Sin llave API de Anthropic — este es el mapeo del cálculo determinista.');

  const { system, user } = buildCollectionPrompt(request);
  const asked = await askClaude(key, system, user, COLLECTION_MAX_TOKENS);
  if (!asked.ok) return degrade(asked.note, asked.model);

  const answer = resolveCollectionAnswer(request, asked.text);
  if (!answer.ok) return degrade('No se pudo leer la respuesta del asistente.', asked.model);

  return json({ ok: true, model: asked.model, ...answer.answer, log: [...parsed.log, ...answer.answer.log] });
}

/**
 * The DECOMPOSE path: the shared component roots against every checked model's
 * billable slots (parts.roots), in one call — the batch is what lets the model
 * keep one back-cushion family consistent across its whole series.
 *
 * Same never-422 posture as the collection op, for the same reason: an invalid
 * row is dropped and reported inside `resolveDecomposeAnswer`, and every
 * failure degrades to the deterministic answer (which only fills a slot with
 * nothing to judge — one same-kind component in the generation — and leaves
 * the rest honestly empty).
 */
async function runDecompose(
  body: unknown, apiKey: () => Promise<string>, admin: ReturnType<typeof createClient>,
): Promise<Response> {
  const parsed = parseDecomposeRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const request = parsed.req;
  const degrade = (note: string, model?: string) => {
    const answer = fallbackDecomposeAnswer(request, note);
    return json({ ok: true, degraded: true, ...(model ? { model } : {}), ...answer, log: [...parsed.log, ...answer.log] });
  };

  const key = await apiKey();
  if (!key) return degrade('Sin llave API de Anthropic — esta es la asignación del cálculo determinista.');

  const { system, user } = buildDecomposePrompt(request);
  const asked = await askClaude(key, system, user, COLLECTION_MAX_TOKENS);
  if (!asked.ok) return degrade(asked.note, asked.model);

  const answer = resolveDecomposeAnswer(request, asked.text);
  if (!answer.ok) return degrade('No se pudo leer la respuesta del asistente.', asked.model);

  return json({ ok: true, model: asked.model, ...answer.answer, log: [...parsed.log, ...answer.answer.log] });
}

type AskResult =
  | { ok: true; text: string; model: string }
  | { ok: false; note: string; model: string };

/** The one call to Claude, shared by both ops — same model, same effort, same
 *  «a failure is a note, never a throw» contract. */
async function askClaude(
  key: string, system: string, user: string, maxTokens: number,
): Promise<AskResult> {
  const anthropic = new Anthropic({ apiKey: key });
  try {
    const response = await anthropic.messages.create({
      model: MATCH_MODEL,
      max_tokens: maxTokens,
      output_config: { effort: 'medium' },
      system,
      messages: [{ role: 'user', content: user }],
    });
    const model = response.model || MATCH_MODEL;
    if (response.stop_reason === 'refusal') {
      return { ok: false, note: 'Claude no pudo completar la sugerencia.', model };
    }
    return {
      ok: true,
      model,
      text: response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
    };
  } catch (e) {
    return { ok: false, note: apiErrorMessage(e), model: MATCH_MODEL };
  }
}

function apiErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Llave API de Anthropic inválida o revocada.';
  if (e instanceof Anthropic.RateLimitError) return 'Límite de uso de la API alcanzado — intenta en un momento.';
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status}.`;
  return 'No se pudo contactar con el asistente.';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
