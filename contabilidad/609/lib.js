// Nucleo del 609 (Pagos al Exterior, DGII). Funciones puras: entra texto CSV,
// sale texto CSV/TXT. Sin I/O, para que los tests corran sin tocar disco.
//
// El 609 se declara en RD$ y los recibos del exterior vienen en US$. La unica
// conversion que no se inventa nada es la que ya hizo el banco: cada cargo de la
// tarjeta 1659 aparece en el estado de cuenta con su monto en pesos. Por eso el
// flujo es recibo -> cargo -> linea del 609, y un recibo sin cargo conciliado no
// entra al formato.

const DIA = 24 * 60 * 60 * 1000;

/** Parser CSV RFC 4180 (comillas dobles, comas y saltos dentro de campo). */
export function parseCsv(text) {
  const limpio = text.replace(/^﻿/, '').replace(/^sep=.\r?\n/i, '');
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') { campo += '"'; i++; } else enComillas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  if (!filas.length) return [];
  const cabecera = filas[0].map((h) => h.trim().toLowerCase());
  return filas.slice(1)
    .filter((f) => f.some((v) => v.trim() !== ''))
    .map((f) => Object.fromEntries(cabecera.map((h, i) => [h, (f[i] ?? '').trim()])));
}

function escapar(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function construirCsv(filas) {
  return filas.map((f) => f.map(escapar).join(',')).join('\r\n');
}

/** Numero a string con 2 decimales y punto — la DGII pide el punto decimal. */
export function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

/**
 * Tasa de ISR vigente a la fecha del pago. La Ley 30-26 bajo publicidad online y
 * licencias de software de 27% a 15% a partir del 1 de julio de 2026, asi que la
 * tasa depende de CUANDO se pago, no de cuando se declara.
 */
export function tasaISR(categoria, fecha, catalogos) {
  const cat = catalogos.categorias[categoria];
  if (!cat) throw new Error(`Categoria desconocida en el ledger: ${categoria}`);
  let vigente = null;
  for (const tramo of cat.tasaISR) if (fecha >= tramo.desde) vigente = tramo;
  if (!vigente) throw new Error(`Sin tasa ISR para ${categoria} en ${fecha}`);
  return vigente;
}

const normalizar = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Ubica el proveedor del ledger que corresponde a un descriptor del estado de cuenta. */
export function proveedorDeDescriptor(descripcion, catalogos) {
  const d = normalizar(descripcion);
  for (const [clave, prov] of Object.entries(catalogos.proveedores)) {
    if ((prov.descriptores || []).some((p) => d.includes(normalizar(p)))) return clave;
  }
  return null;
}

/**
 * Amarra cada recibo con su cargo en la tarjeta. Devuelve tres listas, y las dos
 * de sobrantes importan tanto como la de aciertos: un cargo sin recibo es una
 * factura que falta pedirle al proveedor, y un recibo sin cargo es un pago que no
 * salio de esta tarjeta (o que el banco todavia no ha posteado).
 */
export function conciliar(recibos, cargos, catalogos) {
  const { ventanaDias, toleranciaUSD } = catalogos.conciliacion;
  const disponibles = cargos.map((c, i) => ({
    indice: i,
    fecha: c.fecha,
    descripcion: c.descripcion,
    usd: num(c.monto_usd ?? c.usd),
    rd: num(c.monto_rd ?? c.rd ?? c.dop),
    proveedor: proveedorDeDescriptor(c.descripcion, catalogos),
    tomado: false,
  }));

  const conciliados = [];
  const sinCargo = [];

  for (const r of [...recibos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const monto = num(r.monto);
    const candidatos = disponibles
      .filter((c) => !c.tomado && c.proveedor === r.proveedor)
      .filter((c) => Math.abs(c.usd - monto) <= toleranciaUSD)
      .filter((c) => {
        const delta = (Date.parse(c.fecha) - Date.parse(r.fecha)) / DIA;
        return delta >= -2 && delta <= ventanaDias;
      })
      .map((c) => ({
        cargo: c,
        // El numero de factura dentro del descriptor (Shopify* 555662658) es
        // evidencia directa; gana sobre cualquier cercania de fecha.
        exacto: r.documento && normalizar(c.descripcion).includes(normalizar(r.documento)) ? 1 : 0,
        delta: Math.abs(Date.parse(c.fecha) - Date.parse(r.fecha)),
      }))
      .sort((a, b) => b.exacto - a.exacto || a.delta - b.delta);

    if (!candidatos.length) { sinCargo.push(r); continue; }
    const elegido = candidatos[0];
    elegido.cargo.tomado = true;
    conciliados.push({
      ...r,
      fechaCargo: elegido.cargo.fecha,
      descriptor: elegido.cargo.descripcion,
      montoRD: elegido.cargo.rd,
      tasaCambio: elegido.cargo.usd ? elegido.cargo.rd / elegido.cargo.usd : 0,
      porDocumento: elegido.exacto === 1,
    });
  }

  return { conciliados, sinCargo, sinRecibo: disponibles.filter((c) => !c.tomado) };
}

const periodoDe = (fecha) => fecha.slice(0, 7).replace('-', '');
const aaaammdd = (fecha) => fecha.replace(/-/g, '');

/**
 * Arma las lineas del 609 a partir de recibos ya conciliados.
 *
 * `retener: false` (el caso de Alcover hoy) declara ISR retenido 0.00 porque no se
 * retuvo nada: los cargos salieron directo de la tarjeta. Lo que se DEBIO retener
 * sale aparte, en informeRetencion.
 */
export function lineas609(conciliados, catalogos, { periodo, retener = false } = {}) {
  return conciliados
    .filter((r) => !periodo || periodoDe(r.fecha) === periodo)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.razon_social.localeCompare(b.razon_social))
    .map((r) => {
      const prov = catalogos.proveedores[r.proveedor];
      if (!prov) throw new Error(`Proveedor sin catalogo: ${r.proveedor}`);
      const cat = catalogos.categorias[r.categoria];
      const { tasa } = tasaISR(r.categoria, r.fecha, catalogos);
      const isr = retener ? r.montoRD * tasa : 0;
      return {
        razonSocial: prov.razonSocial,
        tipoId: catalogos.tiposIdentificacion.pasaporteOtro.codigo,
        idTributario: prov.idTributario || '',
        pais: prov.pais,
        tipoServicio: cat.codigoDGII || '',
        detalleServicio: r.concepto,
        relacionado: prov.relacionado,
        documento: r.documento || '',
        fechaDocumento: aaaammdd(r.fecha),
        montoFacturado: money(r.montoRD),
        fechaRetencion: retener ? aaaammdd(r.fechaCargo) : '',
        rentaPresunta: money(r.montoRD),
        isrRetenido: money(isr),
      };
    });
}

const CAMPOS_609 = [
  'razonSocial', 'tipoId', 'idTributario', 'pais', 'tipoServicio', 'detalleServicio',
  'relacionado', 'documento', 'fechaDocumento', 'montoFacturado', 'fechaRetencion',
  'rentaPresunta', 'isrRetenido',
];

/** TXT delimitado por pipe para la Oficina Virtual: encabezado + una linea por pago. */
export function txt609(lineas, { rnc, periodo }) {
  const encabezado = ['609', rnc, periodo, String(lineas.length)].join('|');
  const detalle = lineas.map((l) => CAMPOS_609.map((c) => l[c]).join('|'));
  return [encabezado, ...detalle].join('\r\n') + '\r\n';
}

/** Hoja legible para la contadora: lleva el USD y la tasa que el TXT ya no muestra. */
export function csvContabilidad(conciliados, catalogos, { periodo } = {}) {
  const filas = [[
    'Fecha recibo', 'Fecha cargo', 'Proveedor', 'Cuenta', 'Documento', 'Concepto',
    'Pais', 'USD', 'Tasa', 'RD$', 'Categoria', 'Tasa ISR', 'ISR que aplicaria', 'Descriptor tarjeta',
  ]];
  let usd = 0;
  let rd = 0;
  let isr = 0;
  for (const r of conciliados.filter((x) => !periodo || periodoDe(x.fecha) === periodo)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const prov = catalogos.proveedores[r.proveedor];
    const { tasa } = tasaISR(r.categoria, r.fecha, catalogos);
    const isrLinea = r.montoRD * tasa;
    usd += num(r.monto); rd += r.montoRD; isr += isrLinea;
    filas.push([
      r.fecha, r.fechaCargo, prov.razonSocial, r.cuenta, r.documento, r.concepto,
      prov.pais, money(num(r.monto)), r.tasaCambio.toFixed(4), money(r.montoRD),
      catalogos.categorias[r.categoria].etiqueta, `${(tasa * 100).toFixed(0)}%`,
      money(isrLinea), r.descriptor,
    ]);
  }
  filas.push([]);
  filas.push(['TOTAL', '', '', '', '', '', '', money(usd), '', money(rd), '', '', money(isr), '']);
  return construirCsv(filas);
}

/**
 * Lo que se debio retener y no se retuvo. No es parte del 609 que se sube: es el
 * numero que la contadora necesita para decidir si regulariza via IR-17.
 */
export function informeRetencion(conciliados, catalogos, { periodo } = {}) {
  const porCategoria = new Map();
  for (const r of conciliados.filter((x) => !periodo || periodoDe(x.fecha) === periodo)) {
    const { tasa, base } = tasaISR(r.categoria, r.fecha, catalogos);
    const clave = `${r.categoria}|${tasa}`;
    const acc = porCategoria.get(clave) || {
      etiqueta: catalogos.categorias[r.categoria].etiqueta, tasa, base, rd: 0, isr: 0, n: 0,
    };
    acc.rd += r.montoRD; acc.isr += r.montoRD * tasa; acc.n += 1;
    porCategoria.set(clave, acc);
  }
  const filas = [['Categoria', 'Tasa', 'Base legal', 'Pagos', 'Base RD$', 'ISR no retenido RD$']];
  let totalRD = 0;
  let totalISR = 0;
  for (const a of [...porCategoria.values()].sort((x, y) => x.etiqueta.localeCompare(y.etiqueta))) {
    totalRD += a.rd; totalISR += a.isr;
    filas.push([a.etiqueta, `${(a.tasa * 100).toFixed(0)}%`, a.base, String(a.n), money(a.rd), money(a.isr)]);
  }
  filas.push(['TOTAL', '', '', '', money(totalRD), money(totalISR)]);
  return { csv: construirCsv(filas), totalRD, totalISR };
}

/** Avisos que deben leerse antes de subir nada a la Oficina Virtual. */
export function validar(catalogos, lineas) {
  const avisos = [];
  if (!catalogos.confirmado) {
    avisos.push('catalogos.json tiene confirmado:false — los codigos DGII no han sido validados con la contadora.');
  }
  const sinCodigo = [...new Set(lineas.filter((l) => !l.tipoServicio).map((l) => l.detalleServicio))];
  if (sinCodigo.length) {
    const faltantes = [...new Set(Object.entries(catalogos.categorias)
      .filter(([, c]) => !c.codigoDGII).map(([, c]) => c.etiqueta))];
    avisos.push(`Falta codigoDGII de tipo de servicio para: ${faltantes.join(', ')}.`);
  }
  if (lineas.some((l) => !l.idTributario)) {
    avisos.push('Beneficiarios sin ID tributario del exterior — confirmar que la DGII acepta el campo vacio.');
  }
  return avisos;
}
