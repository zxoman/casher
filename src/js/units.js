// Selling units shared by the renderer pages and the main process.
//
// A product is sold in exactly one unit, and its price and stock are both in
// that unit: a product priced 120/kg and stocked 12.5 means 120 per kilogram
// and twelve and a half kilograms on hand. Piece products stay integers; the
// rest accept decimals.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Units = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PIECE = 'قطعة';

  const UNITS = {
    'قطعة': { key: 'قطعة', decimals: 0, step: 1, increment: 1, isWeight: false },
    'كجم':  { key: 'كجم',  decimals: 3, step: 0.001, increment: 0.25, isWeight: true },
    'جم':   { key: 'جم',   decimals: 2, step: 0.01, increment: 10, isWeight: true },
    'لتر':  { key: 'لتر',  decimals: 3, step: 0.001, increment: 0.25, isWeight: true },
    'مل':   { key: 'مل',   decimals: 2, step: 0.01, increment: 10, isWeight: true },
  };

  const UNIT_LIST = Object.keys(UNITS);

  // Unknown or missing units fall back to piece, so rows written before the
  // column existed behave exactly as they used to.
  function normalizeUnit(unit) {
    return UNITS[unit] ? unit : PIECE;
  }

  function info(unit) {
    return UNITS[normalizeUnit(unit)];
  }

  function unitOf(product) {
    return normalizeUnit(product && product.unit);
  }

  function isPiece(unit) {
    return info(unit).isWeight === false;
  }

  function isWeightUnit(unit) {
    return info(unit).isWeight === true;
  }

  // Quantities are rounded to the unit's precision before they are written or
  // used in a total, so 0.1 + 0.2 does not end up stored as 0.30000000000004.
  function roundQty(qty, unit) {
    const n = Number(qty);
    if (!Number.isFinite(n)) return 0;
    const factor = Math.pow(10, info(unit).decimals);
    return Math.round((n + Number.EPSILON) * factor) / factor;
  }

  function roundMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function formatQty(qty, unit) {
    const u = info(unit);
    return roundQty(qty, unit).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: u.decimals,
    });
  }

  function formatMoney(value) {
    return roundMoney(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // "0.25 كجم" for weight, "3" for pieces (the word is already in the column
  // header, and repeating it on every row makes the receipt noisy).
  function fullQty(qty, unit) {
    const u = normalizeUnit(unit);
    return u === PIECE ? formatQty(qty, u) : formatQty(qty, u) + ' ' + u;
  }

  function minQty(unit) {
    return isPiece(unit) ? 1 : info(unit).step;
  }

  function qtyStep(unit) {
    return String(info(unit).step);
  }

  function qtyIncrement(unit) {
    return info(unit).increment;
  }

  function isWholeQty(qty) {
    return Math.abs(Number(qty) - Math.round(Number(qty))) < 1e-9;
  }

  // Throws on an unusable quantity, otherwise returns it rounded. Piece
  // products reject fractions instead of silently rounding them, because the
  // cashier typing 0.5 almost certainly picked the wrong product.
  function validateQty(qty, unit, label) {
    const n = Number(qty);
    const name = label ? `"${label}"` : 'المنتج';
    if (!Number.isFinite(n) || n <= 0) throw new Error('كمية غير صالحة');
    if (isPiece(unit) && !isWholeQty(n)) {
      throw new Error(`${name} بيتباع بالقطعة — الكمية لازم تكون عدد صحيح`);
    }
    const q = roundQty(n, unit);
    if (q <= 0) throw new Error('كمية غير صالحة');
    return q;
  }

  return {
    PIECE,
    UNIT_LIST,
    UNITS,
    normalizeUnit,
    info,
    unitOf,
    isPiece,
    isWeightUnit,
    roundQty,
    roundMoney,
    formatQty,
    formatMoney,
    fullQty,
    minQty,
    qtyStep,
    qtyIncrement,
    isWholeQty,
    validateQty,
  };
});
