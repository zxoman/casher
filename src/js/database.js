const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

let db;

function initialize(dbDir) {
  dbDir = dbDir || path.join(__dirname, '..', '..', 'database');
  const dbPath = path.join(dbDir, 'clothes.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();
  seedDefaults();
  try {
    const fix = reconcileSalesDrawerEntries();
    if (fix.repaired) {
      console.log(`[db] reconciled drawer entries for ${fix.repaired} sale(s)`);
    }
  } catch (e) {
    // A repair failure must never stop the app from opening. The sale data is
    // untouched either way, so the worst case is a drawer that is still short.
    console.error('[db] drawer reconciliation failed:', e.message);
  }
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      full_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1,
      permissions TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT,
      name TEXT NOT NULL,
      buy_price REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      wholesale_price REAL DEFAULT 0,
      min_sell_price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      min_stock INTEGER DEFAULT 5,
      description TEXT,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      user_id INTEGER,
      total_amount REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      remaining_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      sale_type TEXT DEFAULT 'retail',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER,
      quantity INTEGER DEFAULT 1,
      price REAL DEFAULT 0,
      total REAL DEFAULT 0,
      buy_price REAL DEFAULT 0,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER,
      user_id INTEGER,
      invoice_number TEXT,
      total_amount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      remaining_amount REAL DEFAULT 0,
      payment_source TEXT,
      drawer_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      product_id INTEGER,
      quantity INTEGER DEFAULT 1,
      buy_price REAL DEFAULT 0,
      total REAL DEFAULT 0,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- The header of a return. The returns table holds the lines; before this
    -- table every line was a document of its own, so returning three items
    -- produced three unrelated rows with no shared number and no shared total.
    CREATE TABLE IF NOT EXISTS return_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT,
      type TEXT NOT NULL DEFAULT 'sale',
      sale_id INTEGER,
      purchase_id INTEGER,
      source_invoice TEXT,
      total REAL DEFAULT 0,
      debt_reduced REAL DEFAULT 0,
      cash_amount REAL DEFAULT 0,
      cash_pool TEXT,
      reason TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS currencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT 'ج.م',
      exchange_rate REAL DEFAULT 1,
      is_default BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('individual', 'package')),
      discount_type TEXT NOT NULL CHECK(discount_type IN ('amount', 'percent')),
      discount_value REAL NOT NULL DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS promotion_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS product_compositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER NOT NULL,
      unit_id INTEGER NOT NULL,
      units_per_container INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (container_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (unit_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customer_debt_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT DEFAULT 'sale',
      sale_id INTEGER,
      sale_invoice TEXT,
      product_id INTEGER,
      quantity INTEGER DEFAULT 1,
      amount REAL DEFAULT 0,
      reason TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS suspended_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      customer_id INTEGER,
      customer_name TEXT,
      items TEXT NOT NULL,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT DEFAULT 'amount',
      invoice_date TEXT,
      payment_methods TEXT,
      total_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      start_time DATETIME NOT NULL,
      end_time DATETIME,
      duration INTEGER,
      total_sales INTEGER DEFAULT 0,
      total_amount REAL DEFAULT 0,
      total_paid REAL DEFAULT 0,
      total_remaining REAL DEFAULT 0,
      total_expenses REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_debt REAL DEFAULT 0,
      total_paid_debt REAL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Add missing columns for existing databases
  try { db.exec('ALTER TABLE users ADD COLUMN permissions TEXT'); } catch(e) {}
  try { db.exec("ALTER TABLE returns ADD COLUMN destination TEXT DEFAULT 'مخزون'"); } catch(e) {}
  try { db.exec("ALTER TABLE returns ADD COLUMN purchase_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE returns ADD COLUMN debt_reduced REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE sales ADD COLUMN currency_id INTEGER REFERENCES currencies(id)"); } catch(e) {}
  try { db.exec("ALTER TABLE purchases ADD COLUMN currency_id INTEGER REFERENCES currencies(id)"); } catch(e) {}
  try { db.exec("ALTER TABLE sales ADD COLUMN payment_breakdown TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE purchases ADD COLUMN payment_source TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE purchases ADD COLUMN drawer_type TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE sales ADD COLUMN sale_date TEXT"); } catch(e) {}
  try { db.exec("UPDATE sales SET sale_date = date(created_at) WHERE sale_date IS NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN min_sell_price REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE returns ADD COLUMN type TEXT DEFAULT 'sale'"); } catch(e) {}
  try { db.exec("ALTER TABLE sale_items ADD COLUMN buy_price REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("UPDATE sale_items SET buy_price = (SELECT COALESCE(buy_price, 0) FROM products WHERE id = sale_items.product_id) WHERE buy_price IS NULL OR buy_price = 0"); } catch(e) {}
  try { db.exec("ALTER TABLE sale_items ADD COLUMN original_price REAL DEFAULT 0"); } catch(e) {}
  // Grouping of return lines under one document. Rows written before this
  // column existed keep working: they are folded into a document of their own
  // below, and anything still unlinked is read as a single-line document.
  try { db.exec("ALTER TABLE returns ADD COLUMN document_id INTEGER"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_returns_document ON returns(document_id)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_return_documents_type ON return_documents(type, created_at)"); } catch(e) {}
  backfillReturnDocuments();
  try { db.exec("ALTER TABLE promotion_products ADD COLUMN quantity INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN category_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN total_expenses REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN total_cost REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN total_debt REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE shifts ADD COLUMN total_paid_debt REAL DEFAULT 0"); } catch(e) {}
  // which money pool an expense was paid from, so editing/deleting it can reverse the movement
  try { db.exec("ALTER TABLE expenses ADD COLUMN payment_source TEXT DEFAULT 'none'"); } catch(e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN drawer_type TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE products ADD COLUMN in_capital INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE customers ADD COLUMN archived INTEGER DEFAULT 0"); } catch(e) {}
  // Remove UNIQUE constraint from products.barcode for existing databases
  try {
    const hasUnique = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products' AND sql LIKE '%barcode TEXT UNIQUE%'").get();
    if (hasUnique) {
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec("DROP TABLE IF EXISTS products_new");
      db.exec("CREATE TABLE products_new (id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT, name TEXT NOT NULL, category_id INTEGER, subcategory_id INTEGER, size TEXT, color TEXT, buy_price REAL DEFAULT 0, sell_price REAL DEFAULT 0, wholesale_price REAL DEFAULT 0, stock INTEGER DEFAULT 0, min_stock INTEGER DEFAULT 5, description TEXT, image_path TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, extra_sizes TEXT, stock_m INTEGER DEFAULT 0, stock_l INTEGER DEFAULT 0, stock_xl INTEGER DEFAULT 0, stock_xxl INTEGER DEFAULT 0, stock_xxxl INTEGER DEFAULT 0)");
      db.exec("INSERT INTO products_new SELECT * FROM products");
      db.exec("DROP TABLE products");
      db.exec("ALTER TABLE products_new RENAME TO products");
      db.exec("PRAGMA foreign_keys=ON");
    }
  } catch(e) {}
  // Indexes for the invoice list. Without these the two per-row summary
  // subqueries in invoices.html were a full scan of sale_items for every sale
  // (O(sales x items)): 10k invoices x 40k items took ~40s. sale_items.sale_id
  // turns each of those into an index lookup, created_at removes the temp
  // B-tree sort, and the two item-side indexes make barcode/name search cheap.
  // IF NOT EXISTS keeps this idempotent and free to run on every open.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_created      ON sales(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_customer     ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_products_barcode   ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_returns_sale       ON returns(sale_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drawer_type TEXT NOT NULL CHECK(drawer_type IN ('نقدي','فودافون كاش','انستاباي')),
      amount REAL NOT NULL,
      balance REAL NOT NULL,
      reason TEXT,
      reference_id TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS treasury_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      balance REAL NOT NULL,
      reason TEXT,
      reference_id TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // Seed initial_drawer into drawer_log if setting exists and drawer_log is empty
  try {
    const initVal = db.prepare("SELECT value FROM settings WHERE key='drawer_initial'").get();
    const hasEntry = db.prepare("SELECT COUNT(*) as c FROM drawer_log").get();
    if (initVal && hasEntry.c === 0) {
      const amt = parseFloat(initVal.value) || 0;
      if (amt > 0) {
        db.prepare("INSERT INTO drawer_log (drawer_type, amount, balance, reason, user_id) VALUES ('نقدي',?,?,'رصيد افتتاحي',NULL)").run(amt, amt);
      }
    }
  } catch(e) {}
}

// Re-creates the drawer rows that a cashier sale never got.
//
// The bug: the old POS wrote the sale, its items and the stock decrement with
// one IPC call each, then asked for the drawer entry. That last call asked for
// the cash.drawer permission, a cashier did not have it, it threw, and the
// exception was raised *after* the sale had already been committed. Result:
// the invoice and the stock move exist, the money never reached the drawer.
//
// Only sales that are provably missing are touched. "Provably" means the sale
// carries a positive payment amount and no drawer row exists for it, checked
// both against the new structured reference (sale:<id>) and against the old
// free-text reason ("فاتورة <invoice number>") so historical rows are never
// double counted. Anything ambiguous is left alone for a human to look at.
//
// Idempotent: on the next open the repaired rows match the reference and no
// further rows are added.
function reconcileSalesDrawerEntries() {
  const byMethod = { cash: 'نقدي', vodafone: 'فودافون كاش', instapay: 'انستاباي' };
  const sales = db.prepare(`
    SELECT id, invoice_number, user_id, paid_amount, payment_method, payment_breakdown
    FROM sales WHERE paid_amount > 0
  `).all();
  if (!sales.length) return { repaired: 0, skipped: 0 };

  const existingRef = db.prepare("SELECT id FROM drawer_log WHERE reference_id = ? LIMIT 1");
  const existingReason = db.prepare("SELECT id FROM drawer_log WHERE reason = ? AND reference_id IS NULL LIMIT 1");
  const balanceOf = db.prepare("SELECT balance FROM drawer_log WHERE drawer_type = ? ORDER BY id DESC LIMIT 1");

  let repaired = 0, skipped = 0;
  for (const sale of sales) {
    // Already reconciled on an earlier start, or it carried a row all along.
    if (existingRef.get('sale:' + sale.id)) continue;
    if (existingReason.get('فاتورة ' + sale.invoice_number)) continue;

    let parts = [];
    try { parts = JSON.parse(sale.payment_breakdown || '{}'); } catch (e) { parts = {}; }
    let moves = Object.entries(parts)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => [byMethod[k] || k, Number(v)]);
    // A sale with no usable breakdown still moved cash if it was paid in cash.
    if (!moves.length && sale.payment_method === 'cash' && sale.paid_amount > 0) {
      moves = [['نقدي', Number(sale.paid_amount)]];
    }
    if (!moves.length) { skipped++; continue; }

    // The cashier who rang the sale is the one who took the money, so the repair
    // is attributed to them rather than to whoever happens to be logged in now.
    for (const [drawerType, amount] of moves) {
      const prev = balanceOf.get(drawerType);
      const balance = (prev ? Number(prev.balance) : 0) + amount;
      db.prepare("INSERT INTO drawer_log (drawer_type, amount, balance, reason, reference_id, user_id) VALUES (?,?,?,?,?,?)")
        .run(drawerType, amount, balance, 'فاتورة ' + sale.invoice_number, 'sale:' + sale.id, sale.user_id);
    }
    try {
      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(sale.user_id, 'إصلاح مرتجع درج', `فاتورة ${sale.invoice_number}: استرجاع ${sale.paid_amount} للدرج (فاتورة مسجلة بدون حركة درج)`);
    } catch (e) {}
    repaired++;
  }
  return { repaired, skipped };
}

function seedDefaults() {
  // No automatic seeding - setup page handles initial configuration
}

// Folds pre-document return lines into documents so the history list has the
// same shape for old and new data. Lines written by the same operation share a
// created_at to the second, so grouping on it recovers the original invoices
// where possible and falls back to one document per line where not.
function backfillReturnDocuments() {
  const orphans = db.prepare("SELECT * FROM returns WHERE document_id IS NULL").all();
  if (!orphans.length) return;
  const groups = new Map();
  for (const r of orphans) {
    const key = [r.type || 'sale', r.sale_id || 0, r.purchase_id || 0, r.created_at || ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, rows] of groups) {
    const isPurchase = rows[0].type === 'purchase';
    const prefix = isPurchase ? 'RET-P' : 'RET-S';
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const debt = rows.reduce((s, r) => s + Number(r.debt_reduced || 0), 0);
    // The cash rows of a legacy return were written per line, so the document
    // only records the amount; the delete handler still cleans them up by the
    // old per-line reference.
    const cashAmount = Math.max(0, total - debt);
    const cashPool = cashAmount > 0 ? (isPurchase ? 'treasury' : 'drawer') : null;
    const seq = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 7) AS INTEGER)), 0) + 1 AS n FROM return_documents WHERE type = ?").get(isPurchase ? 'purchase' : 'sale').n;
    const doc = db.prepare(
      `INSERT INTO return_documents (return_number, type, sale_id, purchase_id, source_invoice, total, debt_reduced, cash_amount, cash_pool, reason, user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `${prefix}-${String(seq).padStart(5, '0')}`,
      isPurchase ? 'purchase' : 'sale',
      rows[0].sale_id || null,
      rows[0].purchase_id || null,
      rows[0].sale_invoice || null,
      total, debt, cashAmount, cashPool,
      rows[0].reason || '',
      rows[0].user_id || null,
      rows[0].created_at || null
    );
    for (const r of rows) {
      db.prepare('UPDATE returns SET document_id = ? WHERE id = ?').run(doc.lastInsertRowid, r.id);
    }
  }
}

function getDefaultCurrency() {
  const cur = db.prepare("SELECT * FROM currencies WHERE is_default = 1").get();
  return cur || { code: 'EGP', name: 'جنيه مصري', symbol: 'ج.م', exchange_rate: 1 };
}

// Helper functions
function get(sql, params = {}) {
  return db.prepare(sql).get(params);
}

function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

// Runs fn inside a single transaction so a half-applied settlement or stock
// move can never be committed. Rolls back and rethrows on error.
function transaction(fn) {
  return db.transaction(fn)();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}

function auditLog(userId, action, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(userId, action, details);
}

module.exports = { initialize, get, all, run, transaction, getSetting, setSetting, auditLog, db, getDefaultCurrency };
