# 609 — Pagos al Exterior (DGII)

Todo lo que Alcover paga con la Mastercard **1659** a proveedores del exterior —
Meta, Anthropic, Shopify, OpenAI — es un pago al exterior y se reporta en el
**Formato 609**, a mas tardar el **día 15 del mes siguiente**.

Esto convierte los recibos que llegan a `javier@alcover.do` en el archivo que se
sube a la Oficina Virtual, mas la hoja de detalle para contabilidad.

## Correr

```bash
npm run 609 -- --periodo 202607
```

Escribe en `salida/`:

| Archivo | Para que |
|---|---|
| `609_132917091_<periodo>.txt` | El envio a la Oficina Virtual (pipe-delimitado) |
| `609_<periodo>_detalle.csv` | Hoja legible: USD, tasa, RD$, ISR por linea |
| `609_<periodo>_retencion-no-practicada.csv` | Lo que se debio retener y no se retuvo |
| `609_<periodo>_conciliacion.txt` | Lo que no cuadro contra la tarjeta |

## El paso manual: el estado de cuenta

El 609 se declara **en pesos**, y los recibos vienen en dolares. La unica tasa
que no se inventa nada es la que ya aplico el banco al cobrar la tarjeta, asi
que el generador no convierte: toma el RD$ del estado de cuenta.

Cada mes, exporta el estado de la 1659 a CSV y dejalo en `estado-cuenta/`, con
estas columnas (el orden no importa, el nombre si):

```
fecha,descripcion,monto_usd,monto_rd
2026-07-09,SHOPIFY* 555662658,25.00,1582.75
```

Si el banco solo da PDF, copia el detalle a una hoja de calculo y exporta a CSV.
Los estados **no se versionan** (`.gitignore`): traen el consumo completo de la
empresa. Solo el `EJEMPLO`.

Sin estado de cuenta el generador no inventa montos — dice cuantos recibos hay
esperando y se detiene.

## Como amarra los recibos con los cargos

Un recibo entra al 609 solo si aparece en la tarjeta. El emparejamiento va por
proveedor + monto USD + fecha (ventana de 8 dias, porque el banco postea
despues), y cuando el descriptor trae el numero de factura — `Shopify* 555662658` —
ese numero manda sobre la fecha. Sin eso las dos tiendas Shopify se cruzan: ambas
cobran US$25.00 con dos dias de diferencia.

Lo que no casa no se pierde, sale en `conciliacion.txt`:

- **Cargo sin recibo** → falta pedirle la factura al proveedor.
- **Recibo sin cargo** → se pago con otra tarjeta, o el banco no lo ha posteado.

## Retencion: lo que hay que decidir

Estos cargos salieron directo de la tarjeta, **sin retener ISR**. El formato se
genera declarando `0.00` de ISR retenido, que es lo que realmente paso, y el
calculo de lo que correspondia sale aparte en
`retencion-no-practicada.csv` para que contabilidad decida si regulariza via
IR-17.

Las tasas dependen de la fecha del pago, no de la del envio — la **Ley 30-26**
bajo publicidad online y licencias de software de 27% a 15% el **1 de julio de
2026**:

| Concepto | Hasta 2026-06-30 | Desde 2026-07-01 |
|---|---|---|
| Publicidad online (Meta) | 27% | 15% |
| Licencias de software (Anthropic, Shopify, OpenAI) | 27% | 15% |
| Otros servicios | 27% | 27% |

Para generar el formato **con** la retencion declarada:

```bash
npm run 609 -- --periodo 202607 --retener
```

## Antes del primer envio

`catalogos.json` esta con `"confirmado": false` y tres `codigoDGII` vacios.
Mientras siga asi el TXT sale con sufijo `-BORRADOR` y el generador avisa. Hay
que pedirle a la contadora tres cosas, una sola vez:

1. El **codigo de tipo de servicio** de cada categoria (Publicidad; Regalias y
   otros intangibles; Gastos por trabajos, suministros y servicios).
2. El **codigo de tipo de identificacion** para beneficiarios del exterior sin
   RNC (esta puesto `3` = pasaporte, sin confirmar).
3. Si la DGII acepta el **ID tributario vacio** para estos proveedores, o si hay
   que poner el EIN/BN.

Con eso lleno, se pone `"confirmado": true` y el TXT sale con su nombre final.

## El ledger

`recibos.csv` es la fuente: una linea por recibo del proveedor, con su documento
y su monto en la moneda facturada. Hoy tiene **109 recibos** desde diciembre 2024
(77 Meta, 17 Anthropic, 15 Shopify), levantados de los correos.

Cada mes hay que agregarle los recibos nuevos. La columna `categoria` decide la
tasa de ISR, y `proveedor` tiene que existir en `catalogos.json`.

### Pendiente

- **OpenAI**: los dos recibos de julio 2026 (`2882-7279-9566` y `2443-8074-2998`,
  enviados a contabilidad el 5 de agosto) no estan en el ledger — los montos
  estan solo dentro de los PDF. El cargo aparece en la conciliacion como
  *cargo sin recibo* hasta que se agreguen.
- **Shopify enero–marzo 2026**: seis cargos de US$25.00 sin numero de factura en
  el ledger. La conciliacion los casa igual por monto y fecha; el numero se
  puede tomar del descriptor del estado de cuenta.
