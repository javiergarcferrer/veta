/**
 * EL ORDEN DE LA CADENA DE MIGRACIONES — «una migración se nombra después de
 * toda la cadena, no después del reloj».
 *
 * LO QUE PASÓ, 2026-08-31. La cadena de veta usa timestamps FUTUROS como
 * números de secuencia (iba por 20261219000000), y dos migraciones nuevas se
 * estamparon con la fecha real del calendario: 20260831190000_dealer_brands y
 * 20260831210000_fredericia_assets. El deploy aplica versiones MAYORES que la
 * última registrada, así que las saltó EN SILENCIO: nada rojo en ningún sitio,
 * y las dos tablas sencillamente no existían en prod — con la UI de
 * asignaciones de marcas y la barrida 3D de Fredericia ya publicadas encima.
 * Se re-estamparon como 20261220000000 y 20261221000000 el mismo día.
 *
 * POR QUÉ UN LEDGER Y NO `git log`. El test equivalente de RosetSoft fecha cada
 * archivo con la historia de git, pero aquí ese veredicto no correría nunca:
 * las sesiones trabajan en clones SHALLOW y el checkout del CI también es
 * shallow, así que «cuándo entró esto a la cadena» no tiene respuesta en
 * ninguna máquina que ejecute este archivo. El ledger invierte la carga: la
 * cadena completa vive AQUÍ, ordenada, y añadir una migración exige añadir su
 * línea AL FINAL. Un archivo fechado detrás del máximo no puede añadirse al
 * final sin romper el orden ascendente — el fallo de agosto, en rojo y con
 * receta. Editar el medio del ledger para colarlo es posible, pero ya no es un
 * descuido: es visible en el diff exactamente como reordenar la cadena.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'supabase', 'migrations');

/**
 * LA CADENA, COMPLETA Y EN EL ORDEN EN QUE SE APLICA. Append-only: tu
 * migración nueva va en la última línea, con una versión MAYOR que la que hoy
 * cierra la lista. Si tu nombre no puede ir al final, el nombre está mal — se
 * renombra el archivo, jamás se reordena la lista.
 */
const LEDGER = [
  '20260101000000_veta_baseline.sql',
  '20260804190000_brand_microenvironments.sql',
  '20261130000000_veta_quotes.sql',
  '20261201000000_model_thumbs_and_heroes.sql',
  '20261202000000_brand_membership.sql',
  '20261203000000_function_hardening.sql',
  '20261204000000_catalog_scope_indexes.sql',
  '20261205000000_helpers_off_the_api.sql',
  '20261206000000_pg_trgm_out_of_public.sql',
  '20261207000000_retire_lifestylegarden.sql',
  '20261208000000_material_houses.sql',
  '20261209000000_storage_buckets.sql',
  '20261210000000_fredericia_brand.sql',
  '20261211000000_brand_ladders.sql',
  '20261212000000_import_runs.sql',
  '20261213000000_quote_brand_silo.sql',
  '20261214000000_carl_hansen_brand.sql',
  '20261215000000_lr_etiquette.sql',
  '20261216000000_lr_etiquette_nightly_cron.sql',
  '20261217000000_claude_config.sql',
  '20261218000000_products_supplier_sku.sql',
  '20261219000000_carl_hansen_importer.sql',
  '20261220000000_dealer_brands.sql',
  '20261221000000_fredericia_assets.sql',
  '20261222000000_ligne_roset_models_seed.sql',
];

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

test('toda migración lleva versión de 14 dígitos', () => {
  const bad = files.filter((f) => !/^\d{14}_.+\.sql$/.test(f));
  assert.deepEqual(bad, [], `nombres sin versión parseable: ${bad.join(', ')}`);
});

test('ninguna versión se repite', () => {
  // Supabase registra lo aplicado por VERSIÓN (los 14 dígitos), no por nombre:
  // dos archivos con el mismo prefijo colisionan y el segundo se salta en
  // silencio. El orden del ledger no puede verlo (los sufijos difieren), así
  // que es guardia aparte.
  const seen = new Map();
  const dups = files.filter((f) => {
    const v = f.slice(0, 14);
    if (seen.has(v)) return true;
    seen.set(v, f);
    return false;
  });
  assert.deepEqual(dups, [], `versiones duplicadas: ${dups.join(', ')}`);
});

test('el directorio ES el ledger — ni un archivo más, ni uno menos', () => {
  // La migración que está en disco y no aquí no ha declarado su lugar en la
  // cadena; la que está aquí y no en disco es una cadena que miente. Ambas son
  // la misma instrucción: añade tu línea AL FINAL del ledger.
  assert.deepEqual(files, [...LEDGER].sort(),
    'supabase/migrations y el LEDGER de este test divergen — añade la migración nueva al FINAL del ledger');
});

test('el ledger es estrictamente ascendente — nadie nace detrás de la cadena', () => {
  // El fallo de agosto exactamente: una versión menor que la última aplicada
  // no corre NUNCA, sin ponerse roja en ningún sitio. Con el ledger
  // append-only, un archivo fechado detrás del máximo rompe este orden en
  // cuanto intenta añadirse al final.
  const out = LEDGER.filter((f, i) => i > 0 && !(f > LEDGER[i - 1]));
  assert.deepEqual(out, [],
    `estas entradas no superan a su anterior en el ledger: ${out.join(', ')} — renombra el archivo DESPUÉS de la cadena entera, nunca reordenes la lista`);
});
