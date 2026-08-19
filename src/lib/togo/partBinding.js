/**
 * QUÉ PUEDE OCUPAR UNA RANURA DE COMPONENTE — y cuántas unidades factura.
 *
 * El Estudio de Partes deja ligar CUALQUIER SKU del catálogo a la ranura de un
 * componente (`parts.roots[role]`), y esa cifra entra derecha en la cotización:
 * `piecePartsTotal` suma `precio × partCount(role)` sobre el precio de la base.
 * Nada preguntaba si el SKU ligado ERA un componente. Medido sobre los 10
 * modelos que el dueño ligó a mano, 8 estaban mal, todos vivos (`active`), y
 * todos con la misma forma: UN SKU BASE METIDO EN UNA RANURA DE COMPONENTE.
 *
 *   Noka Left-Arm Loveseat   base $10,700  + `cushion` → NOKA RIGHT-ARM LOVES
 *                                            (COMP. ELEMENT, $10,700)   +100%
 *   Ottoman Armchair         base  $3,030  + $2,550 + $640              +105%
 *   Ottoman Loveseat         base  $5,230  + $4,405 + $1,015            +104%
 *   Ottoman Ottoman          base  $1,830  + $1,445 + $575              +110%
 *   Ottoman Sofa             base  $6,550  + $5,500 + $1,280            +104%
 *   EXCLUSIF gd canapé A     base  $9,560  + `bolster` → EXCLUSIF SOFA
 *                                            ($7,885)                    +82%
 *   Prado Medium Sofa 100    base  $7,890  + `bolster` → …subtype BASE
 *                                            ($5,105)                    +65%
 *   Prado Medium Sofa 120    base  $7,890  + `armCushion` → …BASE ($5,665) +72%
 *
 * Los cuatro Ottoman son su propio caso: PART A / INTERIOR y PART B / EXTERIOR
 * son las DOS ZONAS DE TAPIZADO de la misma pieza (bicolor), que es exactamente
 * lo que `MATERIALIZATION_ROLES` ya modela — y las zonas NO FACTURAN. Al no
 * existir ranuras libres con ese nombre en la cabeza de quien etiquetaba,
 * entraron como cushion/bolster/armCushion, que sí facturan. La pieza terminó
 * cobrándose a sí misma más sus dos zonas: algo más del doble.
 *
 * Este módulo es el portero. No adivina el SKU correcto — DICE QUE NO al que no
 * puede serlo, con el motivo, para que la ranura quede vacía (sin precio, sin
 * cobro) en vez de llena de un número equivocado. Precedente `docCapture`: los
 * checks son DATA (`{code, level, field}`) para que la vista los pinte junto al
 * campo que dudan, y sólo `level:'blocker'` frena.
 *
 * Model puro: sin React, sin db, sin red.
 */

import { UNPRICED_ROLES } from './meshParts.js';

/**
 * El precio de un componente REAL frente al de su base, medido sobre las
 * ligaduras que el dueño confirmó y que el catálogo respalda:
 *
 *   EXCLUSIF armCushion  $450 / $9,560   4.7%      Prado bolster   5.7%
 *   Noka bolster         $565 / $10,700  5.3%      Prado armCush   7.3%
 *   EXCLUSIF cushion   $1,355 / $9,560   14%       Prado cushion    24%
 *   Prado S/3 back cushions $3,535 / $10,395       34%  ← el más caro real
 *
 * y las ocho equivocadas caen en 65–100%. El umbral vive en el hueco: 50% deja
 * 16 puntos de margen sobre el componente legítimo más caro y sigue muy por
 * debajo de cualquier base. La banda 35–50% avisa sin frenar, porque ahí no hay
 * medición todavía y un juego de 3 cojines sobre una pieza chica podría llegar.
 */
export const COMPONENT_MAX_SHARE = 0.5;
export const COMPONENT_WARN_SHARE = 0.35;

/** Subtipos con los que la lista de precios NOMBRA un elemento completo. Son
 *  literales del catálogo, no heurística: 'COMP. ELEMENT' y 'BASE'. */
const BASE_SUBTYPE = /^\s*(COMP\.?\s*ELEMENT|BASE)\s*$/i;

/** Subtipos con los que la lista NOMBRA una zona de tapizado (el patrón
 *  bicolor: PART A / INTERIOR y PART B / EXTERIOR). */
const ZONE_SUBTYPE = /\bPART\s*([AB])\s*\/\s*(INTERIOR|EXTERIOR)\b/i;

/**
 * Qué ES esta fila del catálogo, según lo que la propia lista de precios dice
 * de ella: 'base' (elemento completo), 'zone' (zona de tapizado, con cuál) o
 * null cuando el subtipo no lo declara — que es la mayoría y se resuelve por
 * precio más abajo. Nunca inventa: si el catálogo calla, esto calla.
 */
export function catalogKindOf(product) {
  const subtype = String(product?.subtype || '').trim();
  if (!subtype) return null;
  const zone = ZONE_SUBTYPE.exec(subtype);
  if (zone) return { kind: 'zone', zone: zone[2].toLowerCase() === 'interior' ? 'interior' : 'exterior' };
  if (BASE_SUBTYPE.test(subtype)) return { kind: 'base' };
  return null;
}

/**
 * CUÁNTAS UNIDADES TRAE EL SKU — leído del nombre, que es donde Ligne Roset lo
 * escribe: «PRADO S/2 BACK CUSHIONS», «PRADO SOFA S/3 BACK CUSHIONS»,
 * «PRADO 2 S/2 BOLSTERS». `S/n` es la notación de la lista para un juego de n.
 *
 * Esto es lo que convierte «Se cobra ×» de un número TECLEADO en uno DERIVADO.
 * El tope `COUNT_MAX` existe porque un humano lo escribía y un 100000 mal tecleado
 * multiplicaba el precio de la parte (medido: $30,004,800 en un bicolor
 * corriente). Un dato leído del catálogo no tiene ese modo de fallo.
 *
 * Devuelve null cuando el nombre no lo dice — que se lee como «una unidad por
 * SKU», el supuesto que el catálogo ya tenía, nunca como cero.
 */
export function setSizeOf(product) {
  const hay = `${product?.name || ''} ${product?.subtype || ''}`;
  const m = /\bS\s*\/\s*(\d{1,2})\b/i.exec(hay) || /\b(?:SET|JUEGO)\s+(?:OF|DE)\s+(\d{1,2})\b/i.exec(hay);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * CUÁNTOS JUEGOS factura una ranura: los grupos de malla que llevan ese rol,
 * divididos entre lo que el juego ya cubre, redondeando HACIA ARRIBA — cuatro
 * cojines contra un juego de 2 son dos juegos; tres contra un S/3 es uno.
 *
 * Redondea hacia arriba y nunca baja de 1 porque el error recuperable es cobrar
 * un juego de más (el dueño lo ve en la revisión y lo baja), no entregar una
 * pieza sin sus cojines. Sin `setSize` conocido, un rol etiquetado factura 1:
 * exactamente lo que `partCount` ya hacía por defecto.
 */
export function planPartCount(meshCount, setSize) {
  const n = Number(meshCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const size = Number(setSize);
  if (!Number.isFinite(size) || size < 1) return 1;
  return Math.max(1, Math.ceil(n / size));
}

/**
 * ¿Puede este SKU ocupar esta ranura?
 *
 * `role`      — la ranura que se pretende llenar.
 * `product`   — la fila de catálogo del root ligado (name/subtype/priceUsd).
 * `basePrice` — precio «desde» de la base del propio modelo, para la razón.
 * `baseRoot`  — el `product_root` del propio modelo.
 * `root`      — el root que se quiere ligar.
 *
 * Devuelve una lista de checks. Vacía = adelante. Precedente `docCapture`:
 * data, no prosa suelta, y sólo `blocker` frena el guardado.
 */
export function checkPartBinding({ role, root, product, basePrice, baseRoot } = {}) {
  const checks = [];
  if (!root || UNPRICED_ROLES.includes(role)) return checks;   // una zona/estructura no factura: nada que vigilar

  if (baseRoot && root === baseRoot) {
    checks.push({
      code: 'component-is-own-base', level: 'blocker', field: role,
      message: 'Es el SKU base del propio modelo: la pieza se cobraría a sí misma dos veces.',
    });
    return checks;
  }

  const kind = catalogKindOf(product);
  if (kind?.kind === 'base') {
    checks.push({
      code: 'component-is-complete-element', level: 'blocker', field: role,
      message: `«${product?.subtype}» es un elemento completo en la lista de precios, no un componente.`,
    });
  }
  if (kind?.kind === 'zone') {
    checks.push({
      code: 'component-is-materialization-zone', level: 'blocker', field: role,
      message: `«${product?.subtype}» es una ZONA de tapizado (bicolor), no una parte que se cobre aparte. Va en ${kind.zone === 'interior' ? 'Interior' : 'Exterior'}, que no factura.`,
      suggestRole: kind.zone,
    });
  }

  // `priceUsd` on a raw catalog row, `fromUsd` on an indexed family
  // (`indexProductsByRoot` keeps the cheapest grade). Either is the same
  // question — what this SKU costs — so the caller never has to remap.
  const price = Number(product?.priceUsd ?? product?.fromUsd);
  const base = Number(basePrice);
  if (Number.isFinite(price) && price > 0 && Number.isFinite(base) && base > 0) {
    const share = price / base;
    if (share >= COMPONENT_MAX_SHARE) {
      checks.push({
        code: 'component-costs-like-a-base', level: 'blocker', field: role,
        message: `Cuesta ${Math.round(share * 100)}% de la base (US$${Math.round(price).toLocaleString('en-US')} sobre US$${Math.round(base).toLocaleString('en-US')}). Un componente real de este catálogo va del 5% al 34%.`,
      });
    } else if (share >= COMPONENT_WARN_SHARE) {
      checks.push({
        code: 'component-price-high', level: 'warn', field: role,
        message: `Cuesta ${Math.round(share * 100)}% de la base — alto para un componente. Verifica que sea la parte y no la pieza.`,
      });
    }
  }
  return checks;
}

/** ¿Alguno de estos checks frena? El único predicado que las vistas consultan,
 *  para que «qué frena» tenga una sola definición. */
export function blocks(checks) {
  return (checks || []).some((c) => c?.level === 'blocker');
}
