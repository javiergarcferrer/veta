#!/usr/bin/env node
// Genera el paquete del 609 de un mes.
//
//   node contabilidad/609/generar.js --periodo 202607
//   node contabilidad/609/generar.js --periodo 202607 --retener
//
// Lee recibos.csv (lo que cobraron los proveedores del exterior) y los estados de
// cuenta de la tarjeta 1659 (lo que el banco convirtio a pesos), los amarra, y
// escribe en salida/ el TXT para la Oficina Virtual, el detalle para contabilidad
// y el corte de lo que no se retuvo.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, conciliar, lineas609, txt609, csvContabilidad, informeRetencion, validar, money,
} from './lib.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const o = { retener: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--periodo') o.periodo = argv[++i];
    else if (argv[i] === '--retener') o.retener = true;
    else if (argv[i] === '--estado') o.estado = argv[++i];
  }
  return o;
}

const opciones = args(process.argv.slice(2));
if (!opciones.periodo || !/^\d{6}$/.test(opciones.periodo)) {
  console.error('Falta --periodo AAAAMM (ej: --periodo 202607)');
  process.exit(1);
}

const catalogos = JSON.parse(readFileSync(join(AQUI, 'catalogos.json'), 'utf8'));
const recibos = parseCsv(readFileSync(join(AQUI, 'recibos.csv'), 'utf8'));

const dirEstado = join(AQUI, 'estado-cuenta');
const archivos = opciones.estado
  ? [opciones.estado]
  : (existsSync(dirEstado) ? readdirSync(dirEstado) : [])
      .filter((f) => f.toLowerCase().endsWith('.csv') && !f.startsWith('EJEMPLO'))
      .map((f) => join(dirEstado, f));

const cargos = archivos.flatMap((f) => parseCsv(readFileSync(f, 'utf8')));

const { periodo, retener } = opciones;
const mes = `${periodo.slice(0, 4)}-${periodo.slice(4)}`;
const delMes = (r) => r.fecha.startsWith(mes);

const { conciliados, sinCargo, sinRecibo } = conciliar(recibos, cargos, catalogos);
const conciliadosMes = conciliados.filter(delMes);
const sinCargoMes = sinCargo.filter(delMes);
const sinReciboMes = sinRecibo.filter((c) => c.fecha.startsWith(mes));

const salida = join(AQUI, 'salida');
mkdirSync(salida, { recursive: true });
const escribir = (nombre, texto) => {
  writeFileSync(join(salida, nombre), texto, 'utf8');
  return nombre;
};

const escritos = [];
const lineas = lineas609(conciliadosMes, catalogos, { periodo, retener });
const avisos = validar(catalogos, lineas);

if (!archivos.length) {
  console.log('\n  Sin estado de cuenta de la 1659 en estado-cuenta/.');
  console.log('  El 609 se declara en RD$, asi que sin el estado no hay monto que declarar.');
  console.log(`  Recibos del periodo ${periodo} en espera de conciliar: ${recibos.filter(delMes).length}\n`);
  console.log('  Deja el estado de cuenta en contabilidad/609/estado-cuenta/ y vuelve a correr.');
  console.log('  Formato en estado-cuenta/EJEMPLO-estado-cuenta.csv\n');
  process.exit(0);
}

if (lineas.length) {
  const nombre = catalogos.confirmado
    ? `609_${catalogos.contribuyente.rnc}_${periodo}.txt`
    : `609_${catalogos.contribuyente.rnc}_${periodo}-BORRADOR.txt`;
  escritos.push(escribir(nombre, txt609(lineas, { rnc: catalogos.contribuyente.rnc, periodo })));
  escritos.push(escribir(`609_${periodo}_detalle.csv`, csvContabilidad(conciliadosMes, catalogos, { periodo })));
}

const informe = informeRetencion(conciliadosMes, catalogos, { periodo });
if (conciliadosMes.length) {
  escritos.push(escribir(`609_${periodo}_retencion-no-practicada.csv`, informe.csv));
}

// La conciliacion se escribe siempre, incluso limpia: es la constancia de que el
// mes cuadro contra la tarjeta.
const reporte = [
  `Conciliacion 609 — periodo ${periodo} — tarjeta 1659`,
  `Recibos conciliados: ${conciliadosMes.length}`,
  '',
  'Recibos sin cargo en la tarjeta (no salieron de la 1659, o el banco no los ha posteado):',
  ...(sinCargoMes.length
    ? sinCargoMes.map((r) => `  ${r.fecha}  ${r.razon_social}  US$${money(Number(r.monto))}  ${r.documento}`)
    : ['  (ninguno)']),
  '',
  'Cargos en la tarjeta sin recibo (falta pedir la factura al proveedor):',
  ...(sinReciboMes.length
    ? sinReciboMes.map((c) => `  ${c.fecha}  ${c.descripcion}  US$${money(c.usd)}  RD$${money(c.rd)}`)
    : ['  (ninguno)']),
  '',
].join('\n');
escritos.push(escribir(`609_${periodo}_conciliacion.txt`, reporte));

console.log(`\n  609 — periodo ${periodo} — ALCOVER S.R.L. (RNC ${catalogos.contribuyente.rnc})\n`);
console.log(`  Pagos al exterior conciliados : ${conciliadosMes.length}`);
console.log(`  Monto declarado               : RD$ ${money(lineas.reduce((s, l) => s + Number(l.montoFacturado), 0))}`);
console.log(`  ISR retenido en el formato    : RD$ ${money(lineas.reduce((s, l) => s + Number(l.isrRetenido), 0))}${retener ? '' : '  (no se retuvo: pago con tarjeta)'}`);
if (!retener) console.log(`  ISR que se debio retener      : RD$ ${money(informe.totalISR)}  -> ver retencion-no-practicada.csv`);
if (sinCargoMes.length) console.log(`  Recibos sin cargo             : ${sinCargoMes.length}`);
if (sinReciboMes.length) console.log(`  Cargos sin recibo             : ${sinReciboMes.length}`);

if (avisos.length) {
  console.log('\n  Antes de subir a la Oficina Virtual:');
  for (const a of avisos) console.log(`   - ${a}`);
}
console.log(`\n  Escrito en contabilidad/609/salida/:\n${escritos.map((f) => `   ${f}`).join('\n')}\n`);
