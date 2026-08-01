/**
 * MONEY UNITS — the ONE conversion at the database boundary.
 *
 * THE RULE (CONTRACTS.md): inside this package prices flow as `number` in the
 * price list's MAJOR units — dollars, euros — exactly like the reference app,
 * because that is what makes the ported money rules checkable to the cent
 * against the reference fixtures. The DATABASE stores integer MINOR units plus
 * an ISO currency, because that is the only representation a sum can't drift
 * in. `toMinor` / `fromMinor` are the crossing, and they are the only place
 * either representation is assumed.
 *
 * So: a resolver returns 1234.5; the row holds 123450 + 'USD'. Never store the
 * major-unit float, and never do arithmetic on a value that has been through
 * `fromMinor` more than once.
 */

/**
 * Currencies with NO minor unit — 1 unit is the smallest amount there is.
 * (ISO 4217 exponent 0. The list is the everyday set; an unlisted currency
 * defaults to 2 decimals, which is right for every currency this catalogue is
 * priced in today.)
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** The default exponent — two decimals, the overwhelming majority. */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/** How many decimal places a currency's minor unit has. */
export function currencyExponent(currency?: string | null): number {
  const code = String(currency || '').trim().toUpperCase();
  return code && ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : DEFAULT_CURRENCY_EXPONENT;
}

/**
 * MAJOR units → the integer the database stores. `toMinor(1234.5, 'USD')` is
 * 123450; `toMinor(1234, 'JPY')` is 1234.
 *
 * Binary dust is removed BEFORE rounding: `1.115 * 100` is 111.49999999999999
 * in IEEE-754, which would round DOWN to 111 and lose a cent on a value the
 * dealer typed as three digits. Rounding half-up on the de-dusted value is what
 * every price list on paper does.
 *
 * A non-finite amount is 0 — never NaN, which would poison a sum silently.
 */
export function toMinor(amount: unknown, currency?: string | null): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** currencyExponent(currency);
  return Math.round(Number((n * factor).toFixed(6)));
}

/**
 * The stored integer → MAJOR units, for display and for the ported money rules
 * (which are written in major units). `fromMinor(123450, 'USD')` is 1234.5.
 */
export function fromMinor(minor: unknown, currency?: string | null): number {
  const n = Number(minor);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** currencyExponent(currency);
  return Math.round(n) / factor;
}
