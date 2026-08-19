/**
 * DETECTAR PARTES EN TODA UNA COLECCIÓN — el plan, no la escritura.
 *
 * 90 de los 116 modelos del catálogo no tienen ninguna parte etiquetada, y
 * hacerlo de uno en uno es exactamente el trabajo que produjo los errores que
 * `partBinding` ahora atrapa. Esto propone TODA la colección de una pasada y
 * deja que el dueño la lea junta.
 *
 * ES UNA REVISIÓN, NO UNA APLICACIÓN («proponer siempre», regla del dueño
 * 2026-08, la misma que obedece AutoImportReview a cuarenta modelos de
 * radio): nada se escribe hasta que se pulsa el botón de abajo, y cada fila
 * llega marcada o desmarcada según lo segura que sea.
 *
 * LO QUE YA ESTÁ ETIQUETADO MANDA. La propuesta sólo rellena claves NUEVAS —
 * el mismo contrato que «Detectar partes» tiene en el Estudio para un modelo
 * suelto. Un lote no es ocasión para pisar lo que alguien confirmó a mano.
 *
 * LA CONFIANZA ES UNA CUENTA, NO UNA OPINIÓN. Sale de dónde vino cada rol:
 * un ejemplo confirmado del dueño (firma o medida) vale más que una regla
 * geométrica, y una fila donde TODO salió de heurísticas llega DESMARCADA —
 * aceptar cuarenta propuestas a la vez es justo donde una insegura se cuela sin
 * leerse. Medido: la clasificación geométrica coincide con el etiquetado a mano
 * del dueño en un 78% (Prado), así que una de cada cuatro filas necesita ojo.
 *
 * Model puro: sin React, sin db, sin red.
 */

import { PART_ROLES, PART_LABELS } from './meshParts.js';

/**
 * La fila de revisión de UN modelo: qué se propone, qué se conserva y cuánto de
 * ello se apoya en algo que el dueño ya confirmó.
 *
 * `taughtKeys` son las claves que una referencia de hermano decidió (el llamador
 * las conoce: son las que casaron por `sig`/`size`). Se pasan en vez de
 * re-derivarse aquí para que la vista y el plan no puedan discrepar sobre cuál
 * fue el motivo.
 */
export function planModelParts({ model, groups, proposal, taughtKeys = [] }) {
  const existing = model?.parts?.mats || {};
  const taught = new Set(taughtKeys);
  const mats = { ...(proposal || {}), ...existing };   // lo confirmado gana

  const addedKeys = Object.keys(proposal || {}).filter((k) => !(k in existing));
  const byRole = {};
  for (const k of addedKeys) {
    const r = proposal[k];
    if (!PART_ROLES.includes(r)) continue;
    byRole[r] = (byRole[r] || 0) + 1;
  }
  const taughtCount = addedKeys.filter((k) => taught.has(k)).length;
  // Sin claves nuevas no hay nada que proponer, y una fila así no debe ocupar
  // sitio en la revisión: el dueño está leyendo lo que va a cambiar.
  const proposes = addedKeys.length > 0;

  return {
    modelId: model?.id || null,
    name: model?.name || '',
    parts: { ...(model?.parts || {}), mats },
    groups: (groups || []).length,
    keptKeys: Object.keys(existing).length,
    addedKeys,
    byRole,
    taughtCount,
    /** Toda parte propuesta salió de un ejemplo confirmado. */
    confidence: !proposes ? 'none' : taughtCount === addedKeys.length ? 'alta' : taughtCount > 0 ? 'media' : 'baja',
    proposes,
  };
}

/**
 * El lote entero, ordenado para leerse: lo inseguro primero, porque es lo que
 * hay que mirar y lo que se desmarca solo. Las filas que no proponen nada se
 * cuentan pero no se listan.
 */
export function planPartsBatch(rows) {
  const listed = (rows || []).filter((r) => r?.proposes);
  const rank = { baja: 0, media: 1, alta: 2 };
  const ordered = [...listed].sort((a, b) => (rank[a.confidence] - rank[b.confidence])
    || b.addedKeys.length - a.addedKeys.length
    || String(a.name).localeCompare(String(b.name), 'es'));
  const totals = {};
  for (const r of listed) for (const [role, n] of Object.entries(r.byRole)) totals[role] = (totals[role] || 0) + n;
  return {
    rows: ordered,
    skipped: (rows || []).length - listed.length,
    totals,
    /** Las que arrancan aceptadas: nunca las `baja` (ver la cabecera). */
    accepted: new Set(ordered.filter((r) => r.confidence !== 'baja').map((r) => r.modelId)),
  };
}

/**
 * El plural de cada rol, escrito y no derivado: «cojín» hace «cojines» y
 * «cojín de brazo» hace «cojines de brazo», que ninguna regla de añadir «s»
 * acierta. Son siete palabras — una tabla es más corta que la excepción.
 */
const PLURAL = {
  base: 'cuerpos',
  structure: 'estructuras',
  exterior: 'exteriores',
  interior: 'interiores',
  cushion: 'cojines',
  bolster: 'rulos',
  armCushion: 'cojines de brazo',
};

/** «2 cojines · 1 rulo · 1 estructura» — el resumen de una fila, en las palabras
 *  del dueño y en el orden de PART_ROLES para que dos filas se comparen de un
 *  vistazo. */
export function describeRoles(byRole) {
  return PART_ROLES
    .filter((r) => byRole?.[r])
    .map((r) => `${byRole[r]} ${byRole[r] === 1 ? (PART_LABELS[r] || r).toLowerCase() : (PLURAL[r] || `${r}s`)}`)
    .join(' · ');
}
