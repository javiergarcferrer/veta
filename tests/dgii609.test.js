/**
 * Fija el 609 de pagos al exterior (contabilidad/609).
 *
 * Tres cosas se rompen solas y las tres cuestan dinero real:
 *
 * 1. LA TASA DEPENDE DE LA FECHA DEL PAGO. La Ley 30-26 bajo publicidad online y
 *    licencias de software de 27% a 15% el 1 de julio de 2026. Un mes declarado
 *    con la tasa del otro lado de esa linea da un ISR equivocado.
 *
 * 2. LAS DOS TIENDAS SHOPIFY COBRAN EL MISMO MONTO CON DOS DIAS DE DIFERENCIA.
 *    US$25.00 el 7 y US$25.00 el 9, ambos dentro de la ventana de conciliacion.
 *    Emparejar por monto+fecha cruza los recibos; el numero de factura que viene
 *    en el descriptor ("Shopify* 555662658") es lo unico que los distingue.
 *
 * 3. EL 609 SE DECLARA EN RD$, NO EN US$. El monto que va al formato es el que el
 *    banco convirtio en la tarjeta 1659, no el del recibo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseCsv, conciliar, lineas609, txt609, tasaISR, proveedorDeDescriptor, informeRetencion, validar,
} from '../contabilidad/609/lib.js';

const root = (p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p);
const catalogos = JSON.parse(readFileSync(root('contabilidad/609/catalogos.json'), 'utf8'));

const recibo = (o) => ({
  fecha: '2026-07-07', proveedor: 'shopify', razon_social: 'Shopify Inc.', cuenta: 'Tienda Alcover',
  documento: '554644993', concepto: 'Suscripcion mensual', moneda: 'USD', monto: '25.00',
  categoria: 'licencia_software', ...o,
});

test('609: la tasa de ISR sale de la fecha del pago, no de la del envio', () => {
  // Ley 30-26 entra el 2026-07-01. Un dia antes todavia es 27%.
  assert.equal(tasaISR('publicidad_online', '2026-06-30', catalogos).tasa, 0.27);
  assert.equal(tasaISR('publicidad_online', '2026-07-01', catalogos).tasa, 0.15);
  assert.equal(tasaISR('licencia_software', '2026-06-30', catalogos).tasa, 0.27);
  assert.equal(tasaISR('licencia_software', '2026-07-01', catalogos).tasa, 0.15);
  // Categoria sin tramo nuevo se queda en 27%.
  assert.equal(tasaISR('otros_servicios', '2026-08-01', catalogos).tasa, 0.27);
});

test('609: Meta se reconoce por el descriptor de PayPal, que es quien cobra', () => {
  assert.equal(proveedorDeDescriptor('PAYPAL *META PLATFORMS', catalogos), 'meta');
  assert.equal(proveedorDeDescriptor('paypal *facebk ads', catalogos), 'meta');
  assert.equal(proveedorDeDescriptor('ANTHROPIC PBC', catalogos), 'anthropic');
  assert.equal(proveedorDeDescriptor('SHOPIFY* 555662658', catalogos), 'shopify');
  assert.equal(proveedorDeDescriptor('SUPERMERCADO NACIONAL', catalogos), null);
});

test('609: dos cargos identicos de Shopify no se cruzan — manda el numero de factura', () => {
  const recibos = [
    recibo({ fecha: '2026-07-07', documento: '554644993', cuenta: 'Tienda Alcover' }),
    recibo({ fecha: '2026-07-09', documento: '555662658', cuenta: 'Tienda ALCOVER' }),
  ];
  // El banco postea ambos el mismo dia y en orden invertido: por monto y fecha
  // solos, el recibo del 7 se llevaria el primer cargo de la lista.
  const cargos = [
    { fecha: '2026-07-10', descripcion: 'SHOPIFY* 555662658', monto_usd: '25.00', monto_rd: '1582.75' },
    { fecha: '2026-07-10', descripcion: 'SHOPIFY* 554644993', monto_usd: '25.00', monto_rd: '1580.25' },
  ];
  const { conciliados, sinCargo, sinRecibo } = conciliar(recibos, cargos, catalogos);

  assert.equal(conciliados.length, 2);
  assert.equal(sinCargo.length, 0);
  assert.equal(sinRecibo.length, 0);
  const porDoc = Object.fromEntries(conciliados.map((c) => [c.documento, c]));
  assert.equal(porDoc['554644993'].montoRD, 1580.25);
  assert.equal(porDoc['555662658'].montoRD, 1582.75);
  assert.ok(conciliados.every((c) => c.porDocumento), 'ambos deben casar por numero de factura');
});

test('609: un recibo sin cargo y un cargo sin recibo quedan a la vista, no se pierden', () => {
  const recibos = [
    recibo({ fecha: '2026-07-07', documento: '554644993' }),
    // Pagado con otra tarjeta: no hay cargo en la 1659.
    recibo({ fecha: '2026-07-20', documento: '999999999', monto: '80.00' }),
  ];
  const cargos = [
    { fecha: '2026-07-09', descripcion: 'SHOPIFY* 554644993', monto_usd: '25.00', monto_rd: '1580.25' },
    // Cargo real del que todavia no se tiene la factura.
    { fecha: '2026-07-15', descripcion: 'OPENAI *CHATGPT', monto_usd: '200.00', monto_rd: '12662.00' },
  ];
  const { conciliados, sinCargo, sinRecibo } = conciliar(recibos, cargos, catalogos);

  assert.equal(conciliados.length, 1);
  assert.deepEqual(sinCargo.map((r) => r.documento), ['999999999']);
  assert.deepEqual(sinRecibo.map((c) => c.descripcion), ['OPENAI *CHATGPT']);
});

test('609: el formato lleva el RD$ del banco y declara 0.00 de ISR cuando no se retuvo', () => {
  const recibos = [recibo({ fecha: '2026-07-07' })];
  const cargos = [{ fecha: '2026-07-09', descripcion: 'SHOPIFY* 554644993', monto_usd: '25.00', monto_rd: '1580.25' }];
  const { conciliados } = conciliar(recibos, cargos, catalogos);

  const lineas = lineas609(conciliados, catalogos, { periodo: '202607', retener: false });
  assert.equal(lineas.length, 1);
  const [l] = lineas;
  assert.equal(l.montoFacturado, '1580.25', 'va el monto en pesos, no los US$25.00');
  assert.equal(l.rentaPresunta, '1580.25');
  assert.equal(l.isrRetenido, '0.00');
  assert.equal(l.fechaRetencion, '', 'sin retencion no hay fecha de retencion');
  assert.equal(l.fechaDocumento, '20260707');
  assert.equal(l.pais, 'CA', 'Shopify Inc. es canadiense');

  // Con --retener el mismo pago declara el 15% de la Ley 30-26.
  const [conRetencion] = lineas609(conciliados, catalogos, { periodo: '202607', retener: true });
  assert.equal(conRetencion.isrRetenido, '237.04'); // 1580.25 * 0.15
  assert.equal(conRetencion.fechaRetencion, '20260709', 'la retencion se fecha al cargo');
});

test('609: el TXT lleva encabezado con el conteo y 13 campos por linea', () => {
  const recibos = [
    recibo({ fecha: '2026-07-07', documento: '554644993' }),
    recibo({ fecha: '2026-07-09', documento: '555662658' }),
  ];
  const cargos = [
    { fecha: '2026-07-09', descripcion: 'SHOPIFY* 554644993', monto_usd: '25.00', monto_rd: '1580.25' },
    { fecha: '2026-07-11', descripcion: 'SHOPIFY* 555662658', monto_usd: '25.00', monto_rd: '1582.75' },
  ];
  const { conciliados } = conciliar(recibos, cargos, catalogos);
  const lineas = lineas609(conciliados, catalogos, { periodo: '202607' });
  const txt = txt609(lineas, { rnc: catalogos.contribuyente.rnc, periodo: '202607' });

  const filas = txt.trim().split('\r\n');
  assert.equal(filas[0], `609|${catalogos.contribuyente.rnc}|202607|2`);
  assert.equal(filas.length, 3);
  for (const f of filas.slice(1)) assert.equal(f.split('|').length, 13);
});

test('609: el informe separa lo que se debio retener por tasa vigente', () => {
  const recibos = [
    // Junio: 27%. Julio: 15%. El corte no puede promediarlos.
    recibo({ fecha: '2026-06-07', documento: 'A', proveedor: 'meta', razon_social: 'Meta Platforms, Inc.', categoria: 'publicidad_online', monto: '49.00' }),
    recibo({ fecha: '2026-07-07', documento: 'B', proveedor: 'meta', razon_social: 'Meta Platforms, Inc.', categoria: 'publicidad_online', monto: '49.00' }),
  ];
  const cargos = [
    { fecha: '2026-06-08', descripcion: 'PAYPAL *META', monto_usd: '49.00', monto_rd: '3000.00' },
    { fecha: '2026-07-08', descripcion: 'PAYPAL *META', monto_usd: '49.00', monto_rd: '3000.00' },
  ];
  const { conciliados } = conciliar(recibos, cargos, catalogos);

  assert.equal(Math.round(informeRetencion(conciliados, catalogos, { periodo: '202606' }).totalISR), 810); // 27%
  assert.equal(Math.round(informeRetencion(conciliados, catalogos, { periodo: '202607' }).totalISR), 450); // 15%
});

test('609: no se sube nada mientras los codigos DGII esten sin confirmar', () => {
  const recibos = [recibo()];
  const cargos = [{ fecha: '2026-07-09', descripcion: 'SHOPIFY* 554644993', monto_usd: '25.00', monto_rd: '1580.25' }];
  const { conciliados } = conciliar(recibos, cargos, catalogos);
  const avisos = validar(catalogos, lineas609(conciliados, catalogos, { periodo: '202607' }));

  assert.ok(avisos.some((a) => a.includes('confirmado:false')), 'debe avisar que los codigos no estan validados');
  assert.ok(avisos.some((a) => a.includes('codigoDGII')), 'debe listar los codigos de tipo de servicio faltantes');
});

test('609: el ledger real parsea y sus categorias existen en el catalogo', () => {
  const recibos = parseCsv(readFileSync(root('contabilidad/609/recibos.csv'), 'utf8'));
  assert.ok(recibos.length > 100, 'el ledger trae la historia completa de recibos');
  for (const r of recibos) {
    assert.ok(catalogos.proveedores[r.proveedor], `proveedor sin catalogo: ${r.proveedor}`);
    assert.ok(catalogos.categorias[r.categoria], `categoria sin catalogo: ${r.categoria}`);
    assert.match(r.fecha, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number(r.monto) > 0, `monto invalido en ${r.fecha} ${r.razon_social}`);
  }
});
