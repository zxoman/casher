// Permission model - the single source of truth for what can be granted.
//
// Kept in its own module (no electron, no db) so the rules can be unit tested
// directly. main.js requires it and is still the only place that enforces.

const BASE_ACTIONS = { v: 'عرض', a: 'إضافة', e: 'تعديل', d: 'حذف' };

// extras = standalone permissions that are not CRUD on the page itself.
// adminOnly = the page cannot be delegated to a non-admin at all.
const PERMISSION_SCHEMA = {
  // 'a' = إنشاء عملية بيع. Selling writes sales/sale_items and moves stock.
  pos:        { label: 'نقطة البيع',       base: ['v', 'a'],            extras: { discount: 'منح خصم' } },
  invoices:   { label: 'الفواتير',         base: ['v', 'a', 'e', 'd'],  extras: { settle: 'سداد فاتورة', cancel: 'إلغاء فاتورة' } },
  customers:  { label: 'العملاء',          base: ['v', 'a', 'e', 'd'],  extras: { settle: 'سداد ديون عميل' } },
  suppliers:  { label: 'الموردين',         base: ['v', 'a', 'e', 'd'],  extras: { settle: 'سداد ديون مورد' } },
  returns:    { label: 'المرتجعات',        base: ['v', 'a', 'e', 'd'],  extras: {} },
  products:   { label: 'المنتجات',         base: ['v', 'a', 'e', 'd'],  extras: {} },
  categories: { label: 'الفئات',           base: ['v', 'a', 'e', 'd'],  extras: {} },
  promotions: { label: 'العروض',           base: ['v', 'a', 'e', 'd'],  extras: {} },
  purchases:  { label: 'المشتريات',        base: ['v', 'a', 'e', 'd'],  extras: { settle: 'سداد لمورد' } },
  expenses:   { label: 'المصروفات',        base: ['v', 'a', 'e', 'd'],  extras: {} },
  cash:       { label: 'الخزينة والدرج',   base: ['v'],                  extras: { drawer: 'حركة درج', treasury: 'حركة خزينة' } },
  shifts:     { label: 'الورديات',         base: ['v'],                  extras: { open: 'فتح شيفت', close: 'إنهاء شيفت' } },
  reports:    { label: 'التقارير',         base: ['v'],                  extras: { export: 'تصدير / طباعة' } },
  users:      { label: 'المستخدمون',       base: ['v', 'a', 'e', 'd'],  extras: {}, adminOnly: true },
  backup:     { label: 'النسخ الاحتياطي',  base: ['v', 'a'],             extras: {}, adminOnly: true },
  settings:   { label: 'الإعدادات',        base: ['v', 'e'],             extras: {}, adminOnly: true }
};

const PERMISSION_KEYS = Object.keys(PERMISSION_SCHEMA);

// Every permission key a module accepts, base actions first then extras.
function schemaKeys(module) {
  const def = PERMISSION_SCHEMA[module];
  if (!def) return [];
  return [...def.base, ...Object.keys(def.extras || {})];
}

// Keep only known keys and coerce to real booleans. Called on create/update so a
// crafted request cannot smuggle in arbitrary permission names.
function normalizePermissions(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const m of PERMISSION_KEYS) {
    if (PERMISSION_SCHEMA[m].adminOnly) continue; // never delegable
    const got = src[m] && typeof src[m] === 'object' ? src[m] : {};
    out[m] = {};
    for (const k of schemaKeys(m)) out[m][k] = got[k] === true;
  }
  return out;
}

// A new cashier can see the app and sell; everything else is off by default.
const defaultPermissions = normalizePermissions(
  Object.fromEntries(PERMISSION_KEYS.map(m => [m, { v: PERMISSION_SCHEMA[m].base.includes('v') }]))
);

// The modules the old model knew about. A row containing any of them predates
// the per-module upgrade and is safe to complete.
const OLD_MODEL_MODULES = ['products', 'customers', 'suppliers', 'purchases',
  'expenses', 'cash', 'invoices', 'returns', 'reports'];

// True when a row predates the per-module model and still needs upgrading.
// Keyed on the 'pos' entry because that is the module every upgraded row has.
function isLegacyRow(stored) {
  const src = readPermissions(stored);
  if (!src) return false;
  // No 'pos' entry yet, and at least one module the old model knew about.
  // An empty or unrecognisable row proves nothing, so it stays legacy-free.
  return !Object.prototype.hasOwnProperty.call(src, 'pos')
    && OLD_MODEL_MODULES.some(k => Object.prototype.hasOwnProperty.call(src, k));
}

// Upgrades a permissions row written before the per-module model. Those rows
// only carry the old nine modules, so every page added later looked forbidden
// and the sidebar bounced the user between pages forever. Modules missing from
// the row are restored to whatever the old model actually allowed (they were
// ungated back then); keys that ARE present are never widened.
//
// This is a ONE-TIME upgrade applied when the row is loaded and written back,
// never an overlay on every read - otherwise a permission the admin revoked
// would silently come back on the next check.
function migratePermissions(stored) {
  const src = readPermissions(stored) || {};
  // An empty or unrecognised row is not evidence the user once had selling or
  // shift access, so it gets the plain defaults instead.
  const legacy = isLegacyRow(stored);
  const out = {};
  for (const m of PERMISSION_KEYS) {
    if (PERMISSION_SCHEMA[m].adminOnly) continue;
    const had = (src[m] && typeof src[m] === 'object' && !Array.isArray(src[m])) ? src[m] : null;
    if (had) {
      const keep = {};
      for (const k of schemaKeys(m)) keep[k] = had[k] === true;
      // the old model had a single "may move money" switch on cash
      if (m === 'cash' && had.a === true) { keep.drawer = true; keep.treasury = true; }
      out[m] = keep;
    } else if (!legacy) {
      out[m] = { ...defaultPermissions[m] };
    } else if (m === 'pos') {
      out[m] = { v: true, a: true, discount: false };
    } else if (m === 'categories' || m === 'promotions') {
      out[m] = { v: true, a: false, e: false, d: false };
    } else if (m === 'shifts') {
      out[m] = { v: true, open: true, close: true };
    } else {
      out[m] = { ...defaultPermissions[m] };
    }
  }
  return out;
}

// Reads a permissions column into an object, tolerating NULL and bad JSON.
function readPermissions(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  try {
    const p = JSON.parse(raw);
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null;
  } catch (e) { return null; }
}

// Reads a permissions column into an object, tolerating NULL and bad JSON.
function readPermissions(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  try {
    const p = JSON.parse(raw);
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null;
  } catch (e) { return null; }
}

module.exports = {
  BASE_ACTIONS, PERMISSION_SCHEMA, PERMISSION_KEYS, schemaKeys,
  normalizePermissions, defaultPermissions, migratePermissions, readPermissions,
  isLegacyRow
};
