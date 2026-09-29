const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const {
  BASE_ACTIONS, PERMISSION_SCHEMA, PERMISSION_KEYS, schemaKeys,
  normalizePermissions, defaultPermissions, migratePermissions, readPermissions,
  isLegacyRow
} = require('./src/js/permission-schema');
const { updateSetColumns, writeRequirement } = require('./src/js/sql-guard');
const bcrypt = require('bcryptjs');
const db = require('./src/js/database');
const TelegramBot = require('./src/js/bot/telegram');

let mainWindow;

// ====== Session & Authorization ======
// The main process is the ONLY authority on who is logged in. The renderer
// holds a cosmetic copy in localStorage and must never be trusted for identity.
let sessionUserId = null;
const loginAttempts = new Map(); // username -> { count, until }
// 3 strikes then a short cool-off. Overridable for tests via the env var.
const MAX_LOGIN_ATTEMPTS = Number(process.env.CASHER_MAX_LOGIN_ATTEMPTS) || 3;
// Note: `|| 60` means CASHER_LOCKOUT_MS=0 does NOT mean "no lockout".
const LOCKOUT_MS = (Number(process.env.CASHER_LOCKOUT_MS) || 60) * 1000;
const ROLES = ['admin', 'cashier', 'store'];

function sessionFile() {
  return path.join(app.getPath('userData'), 'session.json');
}

function persistSession() {
  const fs = require('fs');
  try {
    if (sessionUserId) fs.writeFileSync(sessionFile(), JSON.stringify({ userId: sessionUserId }), { mode: 0o600 });
    else if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
  } catch (e) { console.error('persistSession failed', e); }
}

// Always re-read the row so permission edits / deactivation take effect at once.
function currentUser() {
  if (!sessionUserId) return null;
  const u = db.get('SELECT id, username, role, full_name, permissions, is_active FROM users WHERE id = ?', [sessionUserId]);
  if (!u || !u.is_active) { sessionUserId = null; persistSession(); return null; }
  return u;
}

function publicUser(u) {
  if (!u) return null;
  const { id, username, role, full_name, is_active } = u;
  // Hand the renderer the same upgraded shape main enforces, so a stale
  // localStorage copy can never disagree with the server side.
  const permissions = role === 'admin'
    ? null
    : JSON.stringify(migratePermissions(readPermissions(u.permissions)));
  return { id, username, role, full_name, permissions, is_active };
}

function requireAuth() {
  const u = currentUser();
  if (!u) throw new Error('انتهت الجلسة - سجل دخول تاني');
  return u;
}

function requireAdmin() {
  const u = requireAuth();
  if (u.role !== 'admin') throw new Error('غير مصرح - هذي صلاحية المدير فقط');
  return u;
}

function can(page, action) {
  const u = currentUser();
  if (!u) return false;
  if (u.role === 'admin') return true;
  try {
    const raw = readPermissions(u.permissions);
    // A row saved before the per-module upgrade is completed in memory so the
    // user is not locked out of every page until the next login writes it back.
    // Once upgraded, the stored row is the only authority.
    const p = isLegacyRow(raw) ? migratePermissions(raw) : normalizePermissions(raw);
    return !!(p[page] && p[page][action] === true);
  } catch (e) { return false; }
}

function requirePerm(module, action) {
  const u = requireAuth();
  if (u.role === 'admin' || can(module, action)) return u;
  const def = PERMISSION_SCHEMA[module];
  const label = def ? def.label : module;
  const what = (def && def.extras && def.extras[action]) || BASE_ACTIONS[action] || action;
  throw new Error(`مفيش صلاحية: ${label} - ${what}`);
}

// True only while the shop has no users at all (first-run setup wizard).
function isFirstRun() {
  return !db.get('SELECT id FROM users LIMIT 1');
}

// The only settings keys the setup wizard writes before an admin exists.
const SETUP_KEYS = new Set(['shop_name', 'shop_phone', 'printer_size', 'telegram_token', 'telegram_chat_id']);

function countAdmins() {
  return db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND is_active = 1").c;
}

function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.@-]{3,32}$/.test(u);
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 4 && p.length <= 128;
}

// ====== Raw-SQL guard for the generic db-* channels ======
// The renderer legitimately needs ad-hoc SQL for reports and list screens, so we
// keep the channel but fence it off. Writes are now checked against the
// permission matrix: the statement verb decides the action (INSERT -> a,
// UPDATE -> e, DELETE -> d) and the target table decides the module.
//
// Tables mapped to an empty list are reachable only through a named handler
// that calls requirePerm() itself, because their permission is an extra that
// does not line up with plain CRUD (cash movements, shifts, debt settlement).
const SQL_BLOCKED_TABLES = ['users', 'audit_log'];

// table -> verb (i=insert, u=update, d=delete) -> acceptable [module, action].
// A write passes when it satisfies ANY listed pair.
const TABLE_PERMS = {
  // POS may move stock, and only stock: prices and cost need products.e.
  products:            { i: [['products', 'a']], u: [['products', 'e'], ['pos', 'a']], d: [['products', 'd']],
                        restrict: { u: { pos: ['stock'] } } },
  categories:          { i: [['categories', 'a']], u: [['categories', 'e']], d: [['categories', 'd']] },
  promotions:          { i: [['promotions', 'a']], u: [['promotions', 'e']], d: [['promotions', 'd']] },
  promotion_products:  { i: [['promotions', 'a']], u: [['promotions', 'a']], d: [['promotions', 'd']] },
  product_compositions:{ i: [['promotions', 'a']], u: [['promotions', 'a']], d: [['promotions', 'd']] },
  customers:           { i: [['customers', 'a']], u: [['customers', 'e']], d: [['customers', 'd']] },
  suppliers:           { i: [['suppliers', 'a']], u: [['suppliers', 'e']], d: [['suppliers', 'd']] },
  // Selling and invoicing both create sales, so either module can insert them.
  // POS only creates sales; editing one is the invoices page's job.
  sales:               { i: [['pos', 'a'], ['invoices', 'a']], u: [['invoices', 'e']], d: [['invoices', 'd']] },
  sale_items:          { i: [['pos', 'a'], ['invoices', 'a']], u: [['invoices', 'e']], d: [['invoices', 'd']] },
  purchases:           { i: [['purchases', 'a']], u: [['purchases', 'e']], d: [['purchases', 'd']] },
  purchase_items:      { i: [['purchases', 'a']], u: [['purchases', 'e']], d: [['purchases', 'd']] },
  returns:             { i: [['returns', 'a']], u: [['returns', 'e']], d: [['returns', 'd']] },
  suspended_invoices:  { i: [['invoices', 'a']], u: [['invoices', 'e']], d: [['invoices', 'd']] },
  // extra-permission tables: named handlers only
  expenses:            {},
  drawer_log:          {},
  treasury_log:        {},
  cash_log:            {},
  shifts:              {},
  customer_debt_entries: {},
  // admin-only tables
  settings:            {},
  currencies:          {},
  products_lookup:     {}
};

const SQL_DDL = /\b(drop|alter|attach|detach|vacuum|pragma|reindex|create)\b/i;

// Works out which (module, action) a write statement needs, or null for reads.

// --- UPDATE column inspection -------------------------------------------------
// Some routes are allowed to touch a table only to move one thing (POS moving
// stock). Those need the actual column list, otherwise "may sell" would also
// mean "may rewrite the price list".
function guardSql(sql, isWrite) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('استعلام غير صالح');
  if (sql.includes(';') && sql.replace(/;+\s*$/, '').includes(';')) throw new Error('الاستعلامات المتعددة غير مسموحة');
  if (SQL_DDL.test(sql)) throw new Error('تعريف/تعديل المخطط غير مسموح من الواجهة');
  const lower = sql.toLowerCase();
  for (const t of SQL_BLOCKED_TABLES) {
    if (new RegExp(`\\b${t}\\b`).test(lower)) throw new Error(`الجدول ${t} غير متاح - استخدم واجهة المستخدمين`);
  }
  if (!isWrite) return sql;

  const req = writeRequirement(sql);
  if (!req) {
    // A write we cannot parse is a write we cannot authorise.
    throw new Error('الكتابة لازم تكون INSERT / UPDATE / DELETE صريحة');
  }
  if (req.table === 'settings') {
    throw new Error('إعدادات المحل تتغير من صفحة الإعدادات فقط');
  }
  const perTable = TABLE_PERMS[req.table];
  if (!perTable) throw new Error(`الجدول ${req.table} غير متاح للكتابة من الواجهة`);
  const allowed = perTable[req.verb];
  if (!allowed || !allowed.length) {
    throw new Error(`الجدول ${req.table} بيتكتب من العملية المخصّصة بتاعته بس`);
  }
  const u = currentUser();
  if (u && u.role === 'admin') return sql;
  const authorising = allowed.filter(([mod, act]) => can(mod, act));
  if (!authorising.length) {
    // Report against the module the user would most plausibly own, not just the
    // first one listed, so the message points at the right page.
    const known = allowed.filter(([m]) => PERMISSION_SCHEMA[m]);
    const def = PERMISSION_SCHEMA[known.length ? known[0][0] : allowed[0][0]];
    const label = def ? def.label : allowed[0][0];
    const what = BASE_ACTIONS[req.verb] || 'كتابة';
    throw new Error(`مفيش صلاحية: ${label} - ${what}`);
  }
  // A restricted route (POS on products) is only good for its own columns.
  const restrict = perTable.restrict && perTable.restrict[req.verb];
  if (restrict) {
    const wide = authorising.filter(([mod]) => !restrict[mod]);
    if (!wide.length) {
      const cols = updateSetColumns(sql);
      if (!cols) throw new Error('الاستعلام غير واضح - مش قادر أتحقق من الأعمدة');
      const allowedCols = [...new Set(authorising.flatMap(([mod]) => restrict[mod] || []))];
      const extra = cols.filter(c => !allowedCols.includes(c));
      if (extra.length) {
        const owner = PERMISSION_SCHEMA[req.table] ? PERMISSION_SCHEMA[req.table].label : req.table;
        throw new Error(`تعديل ${extra.join('، ')} محتاج صلاحية: ${owner} - ${BASE_ACTIONS.e}`);
      }
    }
  }
  return sql;
}

function createWindow(userDir) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets', 'images', 'icon.png'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'splash.html'));

  mainWindow.once('ready-to-show', () => {
    // Heavy init runs while splash is showing
    const fs = require('fs');
    const oldDb = path.join(__dirname, 'database', 'clothes.db');
    const newDb = path.join(userDir, 'clothes.db');
    if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) {
      try { fs.copyFileSync(oldDb, newDb); } catch (e) { console.error('DB migration failed', e); }
    }
    db.initialize(userDir);
    TelegramBot.initialize();

    // The session is deliberately NOT restored here. Logging out on quit (see the
    // before-quit handler) means a closed app must ask for the password again, and
    // not loading it also covers a hard kill, where before-quit never runs and a
    // session file would otherwise survive on disk.

    const setupDone = db.getSetting('shop_name');
    // If we still have a valid session we go straight in; otherwise login.
    const target = setupDone ? (currentUser() ? 'pos.html' : 'login.html') : 'setup.html';
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', target));
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('db-get', (_, sql, params) => { requireAuth(); return db.get(guardSql(sql, false), params); });
ipcMain.handle('db-all', (_, sql, params) => { requireAuth(); return db.all(guardSql(sql, false), params); });
ipcMain.handle('db-run', (_, sql, params) => { requireAuth(); return db.run(guardSql(sql, true), params); });
ipcMain.handle('db-getSetting', (_, key) => { if (!isFirstRun()) requireAuth(); return db.getSetting(key); });
ipcMain.handle('db-setSetting', (_, key, value) => {
  // The setup wizard runs before any user exists, so it gets a narrow bypass -
  // only the keys that wizard writes, and only while the shop has no users.
  if (isFirstRun()) {
    if (!SETUP_KEYS.has(String(key))) throw new Error('مفتاح إعداد غير مسموح في أول تشغيل');
    return db.setSetting(key, value);
  }
  requireAdmin();
  return db.setSetting(key, value);
});

ipcMain.handle('auth-login', (_, username, password) => {
  const uname = String(username || '').trim();
  const rec = loginAttempts.get(uname);
  if (rec && rec.until > Date.now()) {
    const secs = Math.ceil((rec.until - Date.now()) / 1000);
    return { success: false, message: `محاولات كثيرة. استنى ${secs} ثانية وحاول تاني` };
  }
  const fail = () => {
    const prev = loginAttempts.get(uname) || { count: 0, until: 0 };
    const count = prev.count + 1;
    loginAttempts.set(uname, {
      count,
      until: count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0
    });
    // One message for both cases so usernames can't be enumerated.
    return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
  };

  const user = db.get('SELECT * FROM users WHERE username = ? AND is_active = 1', [uname]);
  if (!user) return fail();
  let valid = false;
  try { valid = bcrypt.compareSync(String(password || ''), user.password); }
  catch (e) { return fail(); }
  if (!valid) return fail();

  loginAttempts.delete(uname);
  sessionUserId = user.id;
  persistSession();
  persistPermissionUpgrade(user);
  db.auditLog(user.id, 'تسجيل دخول', `تسجيل دخول المستخدم ${user.full_name}`);
  TelegramBot.sendNotification('login', { user: user.full_name });
  return { success: true, user: publicUser(user) };
});

ipcMain.handle('auth-logout', () => {
  const u = currentUser();
  if (u) db.auditLog(u.id, 'تسجيل خروج', `تسجيل خروج المستخدم ${u.full_name}`);
  sessionUserId = null;
  persistSession();
  return { success: true };
});

ipcMain.handle('auth-me', () => {
  const u = currentUser();
  if (u) persistPermissionUpgrade(u);
  return publicUser(u);
});

ipcMain.handle('auth-checkSetup', () => {
  // Same signal main.js uses to pick the landing page.
  return !!db.getSetting('shop_name');
});

// Auth handlers that back a form should report failures instead of throwing,
// so the page can show the message.
function adminGate() {
  try { return { user: requireAdmin() }; }
  catch (e) { return { error: { success: false, message: e.message } }; }
}

ipcMain.handle('auth-createAdmin', (_, username, password, fullName) => {
  // Allowed only while the shop has no users (first run). After that, creating or
  // overwriting an admin requires an existing admin session.
  if (!isFirstRun()) { const g = adminGate(); if (g.error) return g.error; }
  if (!validUsername(username) || !validPassword(password) || !String(fullName || '').trim()) {
    return { success: false, message: 'بيانات غير صالحة (اليوزر 3 أحرف على الأقل، والباسورد 4 على الأقل)' };
  }
  const existing = db.get("SELECT id FROM users WHERE role = 'admin'");
  const hash = bcrypt.hashSync(password, 10);
  if (existing) {
    db.run('UPDATE users SET username = ?, password = ?, full_name = ? WHERE id = ?', [username, hash, fullName, existing.id]);
  } else {
    db.run('INSERT INTO users (username, password, role, full_name) VALUES (?, ?, ?, ?)', [username, hash, 'admin', fullName]);
  }
  return { success: true };
});

// ====== PERMISSION SCHEMA - single source of truth ======
// The UI matrix, the defaults, the validation on user create/update and the
// runtime enforcement all read from this. Adding a page or an action here is the
// only place that needs to change; the checkbox grid in users.html is generated.
// Writes the upgraded row back so the users page and the sidebar see the new
// keys. Admin rows stay null (admin is not delegable) and never get rewritten.
function persistPermissionUpgrade(u) {
  if (!u || u.role === 'admin') return false;
  const stored = readPermissions(u.permissions);
  if (!isLegacyRow(stored)) return false;
  const next = JSON.stringify(migratePermissions(stored));
  db.run('UPDATE users SET permissions = ? WHERE id = ?', [next, u.id]);
  u.permissions = next;
  return true;
}

ipcMain.handle('auth-getPermissionSchema', () => {
  requireAdmin();
  return {
    baseLabels: BASE_ACTIONS,
    modules: PERMISSION_KEYS.map(key => ({
      key,
      label: PERMISSION_SCHEMA[key].label,
      adminOnly: !!PERMISSION_SCHEMA[key].adminOnly,
      base: PERMISSION_SCHEMA[key].base,
      extras: PERMISSION_SCHEMA[key].extras || {}
    })),
    defaults: defaultPermissions
  };
});

ipcMain.handle('auth-getUsers', () => {
  requireAdmin();
  return db.all('SELECT id, username, role, full_name, is_active, created_at, permissions FROM users ORDER BY created_at');
});

ipcMain.handle('auth-createUser', (_, username, password, role, fullName, permissions) => {
  const g = adminGate(); if (g.error) return g.error;
  if (!validUsername(username) || !validPassword(password) || !String(fullName || '').trim()) {
    return { success: false, message: 'بيانات غير صالحة (اليوزر 3 أحرف على الأقل، والباسورد 4 على الأقل)' };
  }
  if (!ROLES.includes(role)) return { success: false, message: 'دور غير معروف' };
  if (db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username])) {
    return { success: false, message: 'اسم المستخدم موجود بالفعل' };
  }
  const hash = bcrypt.hashSync(password, 10);
  const perms = role === 'admin' ? null : JSON.stringify(permissions ? normalizePermissions(permissions) : defaultPermissions);
  db.run('INSERT INTO users (username, password, role, full_name, permissions) VALUES (?, ?, ?, ?, ?)', [username, hash, role, fullName, perms]);
  return { success: true };
});

ipcMain.handle('auth-updateUser', (_, id, username, role, fullName, isActive, permissions) => {
  const g = adminGate(); if (g.error) return g.error;
  const actor = g.user;
  if (!ROLES.includes(role)) return { success: false, message: 'دور غير معروف' };
  if (!validUsername(username) || !String(fullName || '').trim()) {
    return { success: false, message: 'اسم المستخدم أو الاسم الكامل غير صالح' };
  }
  if (db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?', [username, id])) {
    return { success: false, message: 'اسم المستخدم موجود بالفعل' };
  }
  const target = db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return { success: false, message: 'المستخدم غير موجود' };
  // No self-demotion / self-deactivation: prevents locking yourself out.
  if (target.id === actor.id && (role !== 'admin' || !isActive)) {
    return { success: false, message: 'ما ينفع تنزل صلاحيتك أو تقفل حسابك بنفسك' };
  }
  // Never remove the last working admin.
  if (target.role === 'admin' && (role !== 'admin' || !isActive) && countAdmins() <= 1) {
    return { success: false, message: 'ما ينفع تنزّل آخر مدير نشط' };
  }
  const perms = role === 'admin' ? null : JSON.stringify(normalizePermissions(permissions));
  db.run('UPDATE users SET username=?, role=?, full_name=?, is_active=?, permissions=? WHERE id=?', [username, role, fullName, isActive ? 1 : 0, perms, id]);
  return { success: true };
});

ipcMain.handle('auth-resetPassword', (_, id, newPassword) => {
  const g = adminGate(); if (g.error) return g.error;
  if (!validPassword(newPassword)) return { success: false, message: 'كلمة المرور لازم 4 أحرف على الأقل' };
  if (!db.get('SELECT id FROM users WHERE id = ?', [id])) return { success: false, message: 'المستخدم غير موجود' };
  const hash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password=? WHERE id=?', [hash, id]);
  return { success: true };
});

ipcMain.handle('auth-deleteUser', (_, id) => {
  const g = adminGate(); if (g.error) return g.error;
  const actor = g.user;
  if (id === actor.id) return { success: false, message: 'ما ينفع تحذف حسابك بنفسك' };
  const user = db.get('SELECT role, is_active FROM users WHERE id=?', [id]);
  if (!user) return { success: false, message: 'المستخدم غير موجود' };
  if (user.role === 'admin' && user.is_active && countAdmins() <= 1) {
    return { success: false, message: 'لا يمكن حذف آخر مدير' };
  }
  // Keep history intact: a user with any recorded movement can only be
  // deactivated, never deleted. These are the tables with a real user_id column.
  const USER_REF_TABLES = ['sales', 'purchases', 'expenses', 'returns', 'shifts',
    'drawer_log', 'treasury_log', 'cash_log', 'suspended_invoices', 'audit_log'];
  const refs = db.get(
    `SELECT (${USER_REF_TABLES.map(t => `(SELECT COUNT(*) FROM ${t} WHERE user_id = ?)`).join(' + ')}) AS c`,
    USER_REF_TABLES.map(() => id)
  );
  if (refs.c > 0) {
    return { success: false, message: `المستخدم ده مسجّل في ${refs.c} حركة، فممنوعش يتحذف. اقفل حسابه بدل الحذف عشان السجل يفضل محفوظ.` };
  }
  db.run('DELETE FROM users WHERE id=?', [id]);
  return { success: true };
});

// Only known pages, basename only - no path traversal out of src/pages.
// Page allowlist. Derived from the permission schema so a new page can never be
// reachable-but-unguarded: it has to be a module first.
const PAGE_MODULE = {
  'pos.html': 'pos', 'invoices.html': 'invoices', 'returns.html': 'returns',
  'products.html': 'products', 'categories.html': 'categories', 'promotions.html': 'promotions',
  'purchases.html': 'purchases', 'customers.html': 'customers', 'suppliers.html': 'suppliers',
  'expenses.html': 'expenses', 'cash.html': 'cash', 'shifts.html': 'shifts',
  'reports.html': 'reports', 'users.html': 'users', 'backup.html': 'backup',
  'settings.html': 'settings'
};
const UNGUARDED_PAGES = ['dashboard.html', 'login.html'];
const ALLOWED_PAGES = new Set([...Object.keys(PAGE_MODULE), ...UNGUARDED_PAGES]);

ipcMain.handle('navigate', (_, page) => {
  const first = isFirstRun();
  if (!first) requireAuth();
  const name = path.basename(String(page || ''));
  if (!ALLOWED_PAGES.has(name)) throw new Error('صفحة غير مسموحة');
  if (!first) {
    const module = PAGE_MODULE[name];
    // Page-level 'view' is enforced here, in main, not just in the sidebar.
    if (module) requirePerm(module, 'v');
  }
  mainWindow.loadFile(path.join(__dirname, 'src', 'pages', name));
});


const TELEGRAM_TYPES = new Set(['sale', 'purchase', 'expense', 'customer', 'login']);

ipcMain.handle('telegram-send', (_, type, data) => {
  const u = requireAuth();
  // Only the known notification kinds - otherwise a renderer could spam the
  // shop's channel with arbitrary text.
  if (!TELEGRAM_TYPES.has(type)) throw new Error('نوع إشعار غير معروف');
  if (!data || typeof data !== 'object') throw new Error('بيانات الإشعار غير صالحة');
  db.auditLog(u.id, 'إشعار تيليجرام', type);
  TelegramBot.sendNotification(type, data);
});

// Shared so the named handlers below can log money without going through IPC.
const DRAWER_TYPES = ['نقدي', 'فودافون كاش', 'انستاباي'];

function drawerBalance(drawerType) {
  const row = db.get('SELECT balance FROM drawer_log WHERE drawer_type=? ORDER BY id DESC LIMIT 1', [drawerType]);
  return row ? row.balance : 0;
}

function treasuryBalance() {
  const row = db.get('SELECT balance FROM treasury_log ORDER BY id DESC LIMIT 1');
  return row ? row.balance : 0;
}

function recordDrawer(userId, drawerType, amount, reason, referenceId) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('مبلغ غير صالح');
  if (!DRAWER_TYPES.includes(drawerType)) throw new Error('نوع درج غير معروف');
  const newBalance = drawerBalance(drawerType) + value;
  const result = db.run('INSERT INTO drawer_log (drawer_type, amount, balance, reason, reference_id, user_id) VALUES (?,?,?,?,?,?)', [drawerType, value, newBalance, reason || '', referenceId || null, userId]);
  return { balance: newBalance, id: result.lastInsertRowid };
}

function recordTreasury(userId, amount, reason, referenceId) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('مبلغ غير صالح');
  const newBalance = treasuryBalance() + value;
  const result = db.run('INSERT INTO treasury_log (amount, balance, reason, reference_id, user_id) VALUES (?,?,?,?,?)', [value, newBalance, reason || '', referenceId || null, userId]);
  return { balance: newBalance, id: result.lastInsertRowid };
}

// Pays real money out of a pool, refusing to overdraw it.
function spendFrom(u, source, drawerType, amount, reason) {
  if (source === 'drawer') {
    if (drawerBalance(drawerType) < amount) throw new Error(`الرصيد غير كافٍ في درج ${drawerType}`);
    recordDrawer(u.id, drawerType, -amount, reason);
  } else if (source === 'treasury') {
    if (treasuryBalance() < amount) throw new Error('الرصيد غير كافٍ في الخزينة');
    recordTreasury(u.id, -amount, reason);
  }
}

// Gives a pool its money back when the expense it paid for is undone.
function refundTo(u, source, drawerType, amount, reason) {
  if (source === 'drawer' && DRAWER_TYPES.includes(drawerType)) recordDrawer(u.id, drawerType, amount, reason);
  else if (source === 'treasury') recordTreasury(u.id, amount, reason);
}


// user_id is taken from the session, never from the renderer, so cash entries
// can never be forged against another user.
ipcMain.handle('cash-addDrawerEntry', (_, drawerType, amount, reason, referenceId) => {
  const u = requirePerm('cash', 'drawer');
  const out = recordDrawer(u.id, drawerType, amount, reason, referenceId);
  db.auditLog(u.id, 'حركة درج', `${drawerType}: ${amount} - ${reason || ''}`);
  return { success: true, balance: out.balance, id: out.id };
});

ipcMain.handle('cash-addTreasuryEntry', (_, amount, reason, referenceId) => {
  const u = requirePerm('cash', 'treasury');
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('مبلغ غير صالح');
  const out = recordTreasury(u.id, value, reason, referenceId);
  db.auditLog(u.id, 'حركة خزينة', `${value} - ${reason || ''}`);
  return { success: true, balance: out.balance, id: out.id };
});

// --- POS sale ---
// Taking cash in a drawer is what selling IS, so pos.a alone authorises this.
// The renderer used to write the sale, its lines and the stock moves through
// window.api.db, then call cash.addDrawerEntry for the payment - and that last
// call asked for cash.drawer on top of pos.a. A cashier with sell rights
// therefore could not take cash at all, and because the drawer entry came
// last, the rejection left a committed sale whose money was never in the
// drawer. The whole thing is one transaction now: the sale, the stock
// movement and the drawer entries either all land or none of them do.
ipcMain.handle('pos-create-sale', (_, payload) => {
  const u = requirePerm('pos', 'a');
  const p = payload || {};
  const raw = Array.isArray(p.items) ? p.items : [];
  if (!raw.length) throw new Error('السلة فارغة');

  // Composition is read from the database rather than taken from the cart, so
  // a crafted renderer cannot claim a container is not linked to its unit.
  const containers = new Map();
  for (const l of db.all('SELECT container_id, unit_id, units_per_container FROM product_compositions')) {
    containers.set(l.container_id, { unitId: l.unit_id, unitsPerContainer: Number(l.units_per_container) || 1 });
  }

  const lines = raw.map((it) => {
    const productId = parseInt(it && it.productId, 10);
    const qty = Number(it && it.qty);
    const price = Number(it && it.price);
    if (!Number.isInteger(productId) || productId <= 0) throw new Error('صنف غير صالح في السلة');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('كمية غير صالحة');
    if (!Number.isFinite(price) || price < 0) throw new Error('سعر غير صالح');
    if (!db.get('SELECT id FROM products WHERE id = ?', [productId])) throw new Error('منتج غير موجود في السلة');
    return { productId, qty, price, buyPrice: Number(it.buyPrice) || 0, originalPrice: Number(it.originalPrice) || price };
  });

  // The money fields are recomputed from the lines so a renderer cannot post a
  // paid_amount that does not match the drawer entries it asks for.
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const discount = Math.min(Math.max(Number(p.discount) || 0, 0), total);
  const afterDiscount = Math.max(0, total - discount);

  const DRAWER_BY_METHOD = { cash: 'نقدي', vodafone: 'فودافون كاش', instapay: 'انستاباي' };
  const breakdown = {};
  const given = (p.breakdown && typeof p.breakdown === 'object') ? p.breakdown : {};
  for (const [k, v] of Object.entries(given)) {
    const amount = Number(v);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const drawerType = DRAWER_BY_METHOD[k] || k;
    if (!DRAWER_TYPES.includes(drawerType)) throw new Error('طريقة دفع غير معروفة: ' + k);
    breakdown[k] = amount;
  }
  const paid = Math.min(Object.values(breakdown).reduce((s, v) => s + v, 0), afterDiscount);
  const remaining = Math.max(0, afterDiscount - paid);
  const method = Object.keys(breakdown).length
    ? Object.entries(breakdown).reduce((a, b) => (a[1] > b[1] ? a : b))[0]
    : 'cash';

  const out = db.transaction(() => {
    const row = db.get('SELECT COALESCE(MAX(id),0)+1 AS nextId FROM sales');
    const nextId = (row && row.nextId) || 1;
    const invoiceNum = 'INV-' + String(nextId).padStart(5, '0');

    const saleDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.saleDate || '')) ? p.saleDate : new Date().toISOString().split('T')[0];
    const customerId = parseInt(p.customerId, 10) || null;
    if (customerId && !db.get('SELECT id FROM customers WHERE id = ?', [customerId])) {
      throw new Error('العميل غير موجود');
    }
    const sale = db.run(
      'INSERT INTO sales (invoice_number, customer_id, user_id, total_amount, discount, paid_amount, remaining_amount, payment_method, payment_breakdown, sale_date) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [invoiceNum, customerId, u.id, total, discount, paid, remaining, method, JSON.stringify(breakdown), saleDate]
    );

    for (const l of lines) {
      db.run('INSERT INTO sale_items (sale_id, product_id, quantity, price, total, buy_price, original_price) VALUES (?,?,?,?,?,?,?)',
        [sale.lastInsertRowid, l.productId, l.qty, l.price, l.qty * l.price, l.buyPrice, l.originalPrice]);
      const link = containers.get(l.productId);
      // A container is stocked by its unit, so the unit is what moves.
      if (link) db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [l.qty * link.unitsPerContainer, link.unitId]);
      else db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [l.qty, l.productId]);
    }
    // Container stock is a reading of the unit stock, not an independent count.
    for (const [containerId, link] of containers) {
      const unit = db.get('SELECT stock FROM products WHERE id = ?', [link.unitId]);
      db.run('UPDATE products SET stock = ? WHERE id = ?',
        [Math.floor((unit ? unit.stock : 0) / link.unitsPerContainer), containerId]);
    }

    // The structured reference is what lets reconcileSalesDrawerEntries() prove
    // a sale is missing its drawer row instead of matching on the reason text.
    for (const [k, v] of Object.entries(breakdown)) {
      recordDrawer(u.id, DRAWER_BY_METHOD[k] || k, v, 'فاتورة ' + invoiceNum, 'sale:' + sale.lastInsertRowid);
    }
    db.auditLog(u.id, 'بيع', `${invoiceNum}: ${afterDiscount} (مدفوع ${paid})`);
    return { success: true, saleId: sale.lastInsertRowid, invoiceNum, barcode: String(nextId), total, discount, afterDiscount, paid, remaining, method, breakdown };
  });
  return out;
});

// --- returns: one document per return, not one row per item ---
// Returning goods is what a return IS, so returns.a authorises it. The old
// flow asked for cash.drawer or cash.treasury on top of it from the renderer,
// so a user with return rights could not get the money back at all; and it
// inserted a line per item and then moved the money per line, so a refusal
// part-way through left lines with no document and cash that never moved.
// One document and one transaction now.
// 'none' = the return moves no money at all: the goods go back to stock and the
// sale side is never settled. Used for a return made without a source invoice,
// where there is no customer debt to clear and no cash to hand over.
// 'debt' with a sale/purchase id reduces that party's invoice balance.
const RETURN_DESTINATIONS = ['debt', 'drawer', 'treasury', 'none'];
const returnContainerMap = () => {
  const m = new Map();
  for (const l of db.all('SELECT container_id, unit_id, units_per_container FROM product_compositions')) {
    m.set(l.container_id, { unitId: l.unit_id, unitsPerContainer: Number(l.units_per_container) || 1 });
  }
  return m;
};
// Container stock is a reading of the unit stock, not an independent count.
const resyncContainerStock = (containers) => {
  for (const [containerId, link] of containers) {
    const unit = db.get('SELECT stock FROM products WHERE id = ?', [link.unitId]);
    db.run('UPDATE products SET stock = ? WHERE id = ?',
      [Math.floor((unit ? unit.stock : 0) / link.unitsPerContainer), containerId]);
  }
};
const moveReturnStock = (containers, productId, qty, delta) => {
  const link = containers.get(productId);
  if (link) db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [delta * qty * link.unitsPerContainer, link.unitId]);
  else db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [delta * qty, productId]);
};

// Validates a return basket, works out the debt/cash split, and writes the
// document, its lines, the stock moves and the money movement. Shared by
// returns-create and returns-update so an edited invoice is built exactly the
// way a new one is.
// `p.reuseNumber` lets an edit keep the number of the invoice it corrects.
function buildReturnDocument(u, p) {
  const isPurchase = p.type === 'purchase';
  const raw = Array.isArray(p.items) ? p.items : [];
  if (!raw.length) throw new Error('اختر منتجات للإرجاع');
  const destination = RETURN_DESTINATIONS.includes(p.destination) ? p.destination : null;
  if (!destination) throw new Error('اختر وجهة المبلغ');

  const containers = returnContainerMap();
  const lines = raw.map((it) => {
    const productId = parseInt(it && it.productId, 10);
    const qty = Number(it && it.qty);
    const price = Number(it && it.price);
    if (!Number.isInteger(productId) || productId <= 0) throw new Error('صنف غير صالح للإرجاع');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('كمية غير صالحة');
    if (!Number.isFinite(price) || price < 0) throw new Error('سعر غير صالح');
    if (!db.get('SELECT id FROM products WHERE id = ?', [productId])) throw new Error('منتج غير موجود');
    return { productId, qty, price, amount: qty * price };
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);

  let sale = null;
  let purchase = null;
  let sourceInvoice = null;
  if (isPurchase) {
    if (destination === 'debt') {
      const pid = parseInt(p.purchaseId, 10);
      if (!pid) throw new Error('اختر فاتورة مشتريات عليها مديونية');
      purchase = db.get('SELECT id, invoice_number, remaining_amount FROM purchases WHERE id = ?', [pid]);
      if (!purchase) throw new Error('فاتورة المشتريات غير موجودة');
      sourceInvoice = purchase.invoice_number;
    }
  } else {
    const sid = parseInt(p.saleId, 10);
    if (sid) {
      sale = db.get('SELECT id, invoice_number, remaining_amount FROM sales WHERE id = ?', [sid]);
      if (!sale) throw new Error('فاتورة البيع غير موجودة');
      sourceInvoice = sale.invoice_number;
      // Never hand back more than was sold, and never hand the same unit back
      // twice: the renderer used to be the only thing enforcing this.
      for (const l of lines) {
        const sold = Number(db.get('SELECT COALESCE(SUM(quantity),0) q FROM sale_items WHERE sale_id = ? AND product_id = ?', [sid, l.productId]).q);
        const back = Number(db.get("SELECT COALESCE(SUM(quantity),0) q FROM returns WHERE (type='sale' OR type IS NULL) AND sale_id = ? AND product_id = ?", [sid, l.productId]).q);
        if (l.qty > sold - back) {
          const row = db.get('SELECT name FROM products WHERE id = ?', [l.productId]);
          throw new Error(`الكمية غير كافية للإرجاع: ${row ? row.name : l.productId} (متاح ${sold - back})`);
        }
      }
    } else if (destination === 'debt') {
      // Debt has to reduce a balance, and the balance lives on the sale or
      // purchase row. Without a source invoice there is nothing to reduce, so
      // a debt destination is only valid when a source was given. Cash out of
      // the drawer or treasury is fine either way.
      throw new Error('اختر فاتورة البيع عشان تخصم من مديونية عميل');
    }
    // drawer / treasury / none with no sale: the goods go back to stock and the
    // money is handed over (or not) without touching a customer balance.
  }

  // Debt takes what it can; anything left over goes to the pool the old flow
  // used (a customer return pays out of the drawer, a supplier return lands in
  // the treasury).
  let debtReduced = 0;
  let cashAmount = 0;
  let cashPool = null;
  if (destination === 'none') {
    // Stock only: nothing is paid out and no balance is cleared.
  } else if (destination === 'debt') {
    const owed = Number((isPurchase ? purchase : sale).remaining_amount) || 0;
    debtReduced = Math.max(0, Math.min(total, owed));
    const rest = Math.round((total - debtReduced) * 100) / 100;
    if (rest > 0) { cashAmount = rest; cashPool = isPurchase ? 'treasury' : 'drawer'; }
  } else {
    cashAmount = total;
    cashPool = destination;
  }

  const stockDelta = isPurchase ? -1 : 1;
  {
    const type = isPurchase ? 'purchase' : 'sale';
    // Numbered off the highest number already issued for this type, not off the
    // row id: the ids are shared with purchase returns, so id + 1 skipped
    // numbers. Taking the max suffix also means a deleted invoice does not
    // hand its number to the next one.
    const seq = db.get("SELECT COALESCE(MAX(CAST(SUBSTR(return_number, 7) AS INTEGER)), 0) + 1 AS n FROM return_documents WHERE type = ?", [type]).n;
    // An edit keeps the number of the invoice it is correcting. The old row has
    // already been purged by the time we get here, so the sequence would
    // otherwise hand out the same number to a different invoice.
    const returnNumber = p.reuseNumber || `${isPurchase ? 'RET-P' : 'RET-S'}-${String(seq).padStart(5, '0')}`;
    const docId = db.run(
      `INSERT INTO return_documents (return_number, type, sale_id, purchase_id, source_invoice, total, debt_reduced, cash_amount, cash_pool, reason, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [returnNumber, type, sale ? sale.id : null, purchase ? purchase.id : null, sourceInvoice, total, debtReduced, cashAmount, cashPool, p.reason || '', u.id]
    ).lastInsertRowid;

    for (const l of lines) {
      const row = db.run(
        'INSERT INTO returns (type, sale_id, sale_invoice, purchase_id, product_id, quantity, amount, reason, destination, user_id, document_id, debt_reduced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [type, sale ? sale.id : null, sale ? sale.invoice_number : null, purchase ? purchase.id : null, l.productId, l.qty, l.amount, p.reason || '', isPurchase ? 'مورد' : 'مخزون', u.id, docId, 0]
      );
      // The debt share stays on the line as well, so the per-line figures the
      // old rows carried keep their meaning.
      const share = total > 0 ? debtReduced * (l.amount / total) : 0;
      if (share > 0) db.run('UPDATE returns SET debt_reduced = ? WHERE id = ?', [share, row.lastInsertRowid]);
    }
    for (const l of lines) moveReturnStock(containers, l.productId, l.qty, stockDelta);
    resyncContainerStock(containers);

    if (debtReduced > 0) {
      if (isPurchase) db.run('UPDATE purchases SET remaining_amount = remaining_amount - ? WHERE id = ?', [debtReduced, purchase.id]);
      else db.run('UPDATE sales SET remaining_amount = remaining_amount - ? WHERE id = ?', [debtReduced, sale.id]);
    }
    if (cashAmount > 0) {
      // A customer return takes money out of the shop, a supplier return brings
      // it back in.
      const signed = isPurchase ? cashAmount : -cashAmount;
      const reason = `${isPurchase ? 'إرجاع مشتريات' : 'إرجاع مبيعات'} ${returnNumber}`;
      if (cashPool === 'drawer') recordDrawer(u.id, 'نقدي', signed, reason, 'returndoc:' + docId);
      else recordTreasury(u.id, signed, reason, 'returndoc:' + docId);
    }
    db.auditLog(u.id, isPurchase ? 'مرتجع مشتريات' : 'مرتجع مبيعات', `${returnNumber}: ${total} (نقدي ${cashAmount} من ${cashPool || 'لا شيء'})`);
    return { success: true, documentId: docId, returnNumber, total, debtReduced, cashAmount, cashPool };
  }
}

ipcMain.handle('returns-create', (_, payload) => {
  const u = requirePerm('returns', 'a');
  // Wrapped here so a create is one atomic unit; returns-update already runs
  // inside its own transaction and calls buildReturnDocument directly.
  return db.transaction(() => buildReturnDocument(u, payload || {}));
});

// Undoes one whole return invoice: stock, the debt it cleared and its cash rows,
// then the lines and the header. Must run inside a transaction; the caller owns
// the permission check and the audit entry.
function purgeReturnDocument(id, containers) {
  const doc = db.get('SELECT * FROM return_documents WHERE id = ?', [id]);
  if (!doc) return null;
  const lines = db.all('SELECT id, product_id, quantity FROM returns WHERE document_id = ?', [id]);
  const isPurchase = doc.type === 'purchase';
  for (const l of lines) moveReturnStock(containers, l.product_id, l.quantity, isPurchase ? 1 : -1);

  const debt = Number(doc.debt_reduced) || 0;
  if (debt > 0) {
    if (isPurchase && doc.purchase_id) db.run('UPDATE purchases SET remaining_amount = remaining_amount + ? WHERE id = ?', [debt, doc.purchase_id]);
    else if (!isPurchase && doc.sale_id) db.run('UPDATE sales SET remaining_amount = remaining_amount + ? WHERE id = ?', [debt, doc.sale_id]);
  }
  deleteCashByReference('returndoc:' + id);
  // Documents folded in from the old per-line data still have their cash rows
  // filed under the old per-line reference.
  for (const l of lines) deleteCashByReference('return:' + l.id);

  db.run('DELETE FROM returns WHERE document_id = ?', [id]);
  db.run('DELETE FROM return_documents WHERE id = ?', [id]);
  return doc;
}

// Rewrites a return invoice. The old lines, their stock moves, the debt they
// cleared and the money they moved are all undone by purgeReturnDocument, then
// the document is rebuilt from the submitted basket through the same path a
// fresh return takes, so an edit cannot end up half applied.
ipcMain.handle('returns-update', (_, documentId, payload) => {
  const u = requirePerm('returns', 'u');
  const id = parseInt(documentId, 10);
  if (!Number.isInteger(id)) throw new Error('رقم المرتجع غير صالح');
  const p = payload || {};

  return db.transaction(() => {
    const existing = db.get('SELECT * FROM return_documents WHERE id = ?', [id]);
    if (!existing) throw new Error('المرتجع مش موجود');
    if (existing.type !== (p.type || existing.type)) throw new Error('نوع المرتجع مش قابل للتغيير');

    const items = Array.isArray(p.items) ? p.items : [];
    if (!items.length) throw new Error('اختر منتجات للإرجاع');

    const containers = returnContainerMap();
    // Undo first, so the validation below runs against the stock the products
    // have right now, not against the stock the old return had already taken.
    purgeReturnDocument(id, containers);
    resyncContainerStock(containers);
    // The old document row is gone, so the number has to be carried over from
    // what was read before the purge: an edited invoice keeps the number the
    // customer was already given.
    return buildReturnDocument(u, {
      type: existing.type,
      reuseNumber: existing.return_number,
      saleId: p.saleId != null ? p.saleId : existing.sale_id,
      purchaseId: p.purchaseId != null ? p.purchaseId : existing.purchase_id,
      reason: p.reason != null ? p.reason : existing.reason,
      destination: p.destination || 'drawer',
      items
    });
  });
});

ipcMain.handle('returns-delete', (_, documentId) => {
  const u = requirePerm('returns', 'd');
  const id = parseInt(documentId, 10);
  if (!Number.isInteger(id)) throw new Error('رقم المرتجع غير صالح');
  return db.transaction(() => {
    const containers = returnContainerMap();
    const doc = purgeReturnDocument(id, containers);
    if (!doc) throw new Error('المرتجع مش موجود');
    resyncContainerStock(containers);
    db.auditLog(u.id, 'حذف مرتجع', String(doc.return_number || id));
    return { success: true };
  });
});

// ====== Named operations for the extra (non-CRUD) permissions ======
// These own tables that TABLE_PERMS refuses to expose to raw SQL, so the extra
// permission is the only thing that can authorise them.

// --- debt settlement (customers.settle / suppliers.settle) ---
// payments: [{ kind:'sale'|'purchase'|'direct', id, amount }]
// drawerBreakdown: { cash, vodafone, instapay } - optional, defaults to all cash
ipcMain.handle('debt-settle', (_, party, payments, drawerBreakdown) => {
  const isCustomer = party === 'customer';
  const u = requirePerm(isCustomer ? 'customers' : 'suppliers', 'settle');
  // Paying a supplier moves real money out of the treasury, so it also needs
  // the treasury permission, not just suppliers.settle.
  if (!isCustomer) requirePerm('cash', 'treasury');
  if (!Array.isArray(payments) || !payments.length) return { success: false, message: 'مفيش مبالغ للتسديد' };
  const method = { cash: 'نقدي', vodafone: 'فودافون كاش', instapay: 'انستاباي' };
  let applied = 0;
  let total = 0;

  // All-or-nothing: if any requested line cannot be applied we throw before the
  // drawer is touched, and db.transaction rolls the document updates back. A
  // partial settlement is never a valid state.
  const built = [];
  for (const p of payments) {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (p.kind === 'direct') {
      const cid = parseInt(p.id, 10);
      if (!cid || !db.get('SELECT id FROM customers WHERE id = ?', [cid])) {
        return { success: false, message: 'العميل غير موجود - التسديد ملغى بالكامل' };
      }
      built.push({ kind: 'direct', id: cid, amount });
      continue;
    }
    const id = parseInt(p.id, 10);
    const table = isCustomer ? 'sales' : 'purchases';
    const row = db.get(`SELECT remaining_amount FROM ${table} WHERE id = ?`, [id]);
    if (!row) return { success: false, message: `الفاتورة ${id} غير موجودة - التسديد ملغى بالكامل` };
    // never let an over-payment push the document into a credit
    const capped = Math.min(amount, Number(row.remaining_amount) || 0);
    if (capped <= 0) return { success: false, message: `الفاتورة ${id} مسددة بالفعل - التسديد ملغى بالكامل` };
    built.push({ kind: p.kind, id, amount: capped });
  }
  if (!built.length) return { success: false, message: 'مفيش مبلغ صالح للتسديد' };

  db.transaction(() => {
    for (const p of built) {
      if (p.kind === 'direct') {
        db.run('INSERT INTO customer_debt_entries (customer_id, amount, description, user_id) VALUES (?,?,?,?)',
          [p.id, -p.amount, 'تسديد دين مباشر', u.id]);
      } else {
        const table = isCustomer ? 'sales' : 'purchases';
        db.run(`UPDATE ${table} SET paid_amount = paid_amount + ?, remaining_amount = remaining_amount - ? WHERE id = ?`,
          [p.amount, p.amount, p.id]);
      }
      applied++;
      total += p.amount;
    }
  });
  const label = isCustomer ? 'تسديد ديون عميل' : 'تسديد ديون مورد';
  if (isCustomer) {
    // Customer pays us: money comes IN to the drawer.
    const bd = (drawerBreakdown && typeof drawerBreakdown === 'object') ? drawerBreakdown : null;
    if (bd) {
      let logged = 0;
      for (const [k, v] of Object.entries(bd)) {
        const amt = Number(v);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        recordDrawer(u.id, method[k] || k, amt, label);
        logged += amt;
      }
      // keep the drawer honest if the split does not add up to the settlement
      if (Math.abs(logged - total) > 0.009) recordDrawer(u.id, 'نقدي', total - logged, label + ' (فرق تقسيط)');
    } else {
      recordDrawer(u.id, 'نقدي', total, label);
    }
  } else {
    // We pay the supplier: money leaves the treasury.
    const last = db.get('SELECT balance FROM treasury_log ORDER BY id DESC LIMIT 1');
    const newBalance = (last ? last.balance : 0) - total;
    if (newBalance < 0) return { success: false, message: 'رصيد الخزينة مش كافي للتسديد' };
    db.run('INSERT INTO treasury_log (amount, balance, reason, reference_id, user_id) VALUES (?,?,?,?,?)',
      [-total, newBalance, label, null, u.id]);
  }
  db.auditLog(u.id, 'تسديد ديون', `${isCustomer ? 'عميل' : 'مورد'}: ${total}`);
  return { success: true, applied, total };
});

// Display names only: username/role/permissions/password are never exposed.
// The pages that show "who did this" used to JOIN users, which SQL_BLOCKED_TABLES
// now denies, so those lists silently rendered empty.
ipcMain.handle('users-nameMap', () => {
  requireAuth();
  return db.all('SELECT id, full_name FROM users ORDER BY full_name');
});

// --- expenses: the row and the money move together or not at all ---
// An expense is really a withdrawal, so it cannot be a raw INSERT: the balance
// check, the permission for the pool it pays from, and the cash entry all have
// to happen inside one transaction with the expense row.
ipcMain.handle('expense-save', (_, payload) => {
  requireAuth();
  const p = payload || {};
  const editing = p.id !== undefined && p.id !== null && p.id !== '';
  const u = requirePerm('expenses', editing ? 'e' : 'a');

  const description = String(p.description == null ? '' : p.description).trim();
  if (!description) throw new Error('وصف المصروف مطلوب');
  if (description.length > 200) throw new Error('الوصف طويل أوي (الحد 200 حرف)');
  const amount = Number(p.amount);
  if (!Number.isFinite(amount)) throw new Error('المبلغ غير صالح');
  if (amount <= 0) throw new Error('المبلغ لازم يكون رقم أكبر من صفر');
  const source = ['drawer', 'treasury', 'none'].includes(p.source) ? p.source : 'none';
  const drawerType = DRAWER_TYPES.includes(p.drawerType) ? p.drawerType : null;
  if (source === 'drawer' && !drawerType) throw new Error('اختر نوع الدرج');
  // Moving money needs its own permission, not just expenses.a.
  if (source === 'drawer') requirePerm('cash', 'drawer');
  if (source === 'treasury') requirePerm('cash', 'treasury');

  const label = 'مصروف - ' + description;
  const out = db.transaction(() => {
    let previous = null;
    if (editing) {
      previous = db.get('SELECT * FROM expenses WHERE id=?', [p.id]);
      if (!previous) throw new Error('المصروف مش موجود');
    }
    // Editing the description only must not touch money, so the old entry is
    // given back and the new one taken in the same transaction. Net effect is
    // exactly the difference, and both halves stay in the audit trail.
    if (previous) refundTo(u, previous.payment_source, previous.drawer_type, Number(previous.amount), 'تعديل ' + label);
    spendFrom(u, source, drawerType, amount, label);

    let id;
    if (editing) {
      db.run('UPDATE expenses SET description=?, amount=?, category=?, payment_source=?, drawer_type=? WHERE id=?',
        [description, amount, p.category || null, source, drawerType, p.id]);
      id = p.id;
    } else {
      const res = db.run('INSERT INTO expenses (description, amount, category, user_id, payment_source, drawer_type) VALUES (?,?,?,?,?,?)',
        [description, amount, p.category || null, u.id, source, drawerType]);
      id = res.lastInsertRowid;
    }
    db.auditLog(u.id, editing ? 'تعديل مصروف' : 'مصروف', `${description}: ${amount}${source === 'none' ? '' : ' (' + source + ')'}`);
    return { success: true, id };
  });
  return out;
});

// Deleting an expense has to return the money it took, otherwise the drawer
// keeps a deduction for a record that no longer exists.
ipcMain.handle('expense-delete', (_, id) => {
  requireAuth();
  const u = requirePerm('expenses', 'd');
  const expenseId = parseInt(id, 10);
  if (!Number.isInteger(expenseId)) throw new Error('رقم المصروف غير صالح');
  return db.transaction(() => {
    const e = db.get('SELECT * FROM expenses WHERE id=?', [expenseId]);
    if (!e) throw new Error('المصروف مش موجود');
    if (e.payment_source === 'drawer') requirePerm('cash', 'drawer');
    if (e.payment_source === 'treasury') requirePerm('cash', 'treasury');
    db.run('DELETE FROM expenses WHERE id=?', [expenseId]);
    refundTo(u, e.payment_source, e.drawer_type, Number(e.amount), 'إلغاء مصروف - ' + e.description);
    db.auditLog(u.id, 'حذف مصروف', `${e.description}: ${e.amount}`);
    return { success: true };
  });
});

// --- manual debt entry (customers.settle covers charging a customer too) ---
ipcMain.handle('debt-add-entry', (_, customerId, amount, description) => {
  const u = requirePerm('customers', 'settle');
  const cid = parseInt(customerId, 10);
  const value = Number(amount);
  if (!cid) return { success: false, message: 'عميل غير صالح' };
  if (!Number.isFinite(value) || value === 0) return { success: false, message: 'مبلغ غير صالح' };
  const r = db.run('INSERT INTO customer_debt_entries (customer_id, amount, description, user_id) VALUES (?,?,?,?)',
    [cid, value, description || '', u.id]);
  db.auditLog(u.id, 'دين على عميل', `${cid}: ${value}`);
  return { success: true, id: r.lastInsertRowid };
});

// --- shift open / close (shifts.open / shifts.close) ---
ipcMain.handle('shift-open', (_, startTime) => {
  const u = requirePerm('shifts', 'open');
  if (db.get("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'", [u.id])) {
    return { success: false, message: 'في شيفت مفتوح بالفعل' };
  }
  const r = db.run("INSERT INTO shifts (user_id, user_name, status, start_time) VALUES (?,?, 'open', ?)",
    [u.id, u.full_name, startTime || new Date().toISOString()]);
  db.auditLog(u.id, 'فتح شيفت', String(r.lastInsertRowid));
  return { success: true, id: r.lastInsertRowid };
});

ipcMain.handle('shift-close', (_, id, summary) => {
  const u = requirePerm('shifts', 'close');
  const shift = db.get("SELECT * FROM shifts WHERE id = ? AND status = 'open'", [id]);
  if (!shift) return { success: false, message: 'الشيفت مش مفتوح' };
  const s = summary || {};
  const patch = {
    end_time: s.end_time, duration: s.duration, total_sales: s.total_sales,
    total_amount: s.total_amount, total_paid: s.total_paid, total_remaining: s.total_remaining,
    total_expenses: s.total_expenses, total_cost: s.total_cost, total_debt: s.total_debt,
    total_paid_debt: s.total_paid_debt
  };
  db.run(`UPDATE shifts SET status='closed', ${Object.keys(patch).map(k => `${k}=?`).join(', ')} WHERE id=?`,
    [...Object.values(patch), id]);
  db.auditLog(u.id, 'إنهاء شيفت', String(id));
  return { success: true };
});

// --- deleting a single cash entry (cash.drawer / cash.treasury) ---
// Rebuilds the running balance for everything after the deleted row so the
// chain stays consistent, then removes it.
ipcMain.handle('cash-deleteEntry', (_, table, id) => {
  const isDrawer = table === 'drawer';
  const t = isDrawer ? 'drawer_log' : table === 'treasury' ? 'treasury_log' : null;
  if (!t) throw new Error('جدول غير معروف');
  const u = requirePerm('cash', isDrawer ? 'drawer' : 'treasury');
  const entryId = parseInt(id, 10);
  const row = entryId ? db.get(`SELECT * FROM ${t} WHERE id = ?`, [entryId]) : null;
  if (!row) return { success: false, message: 'الحركة غير موجودة' };

  db.transaction(() => {
    db.run(`DELETE FROM ${t} WHERE id = ?`, [entryId]);
    if (isDrawer) {
      let bal = Number(row.balance) - Number(row.amount);
      const rest = db.all(`SELECT id, amount FROM ${t} WHERE drawer_type = ? AND id > ? ORDER BY id`, [row.drawer_type, entryId]);
      for (const r of rest) {
        db.run(`UPDATE ${t} SET balance = ? WHERE id = ?`, [bal, r.id]);
        bal += Number(r.amount);
      }
    } else {
      let bal = Number(row.balance) - Number(row.amount);
      const rest = db.all(`SELECT id, amount FROM ${t} WHERE id > ? ORDER BY id`, [entryId]);
      for (const r of rest) {
        db.run(`UPDATE ${t} SET balance = ? WHERE id = ?`, [bal, r.id]);
        bal += Number(r.amount);
      }
    }
  });
  db.auditLog(u.id, 'حذف حركة', `${t}#${entryId}`);
  return { success: true };
});

// Deletes the cash rows an operation wrote and rebuilds the running balances
// behind them. Shared: the cash page calls it through the IPC handler and the
// returns cleanup calls it inside its own transaction, so a deleted return
// invoice and its money move together.
function deleteCashByReference(ref) {
  const reference = String(ref || '');
  if (!reference) return [];
  const touched = [];
  for (const [t] of [['drawer_log'], ['treasury_log']]) {
    const rows = db.all(`SELECT * FROM ${t} WHERE reference_id = ?`, [reference]);
    if (!rows.length) continue;
    db.run(`DELETE FROM ${t} WHERE reference_id = ?`, [reference]);
    const byType = {};
    for (const r of rows) {
      const key = t === 'drawer_log' ? r.drawer_type : '_all';
      (byType[key] = byType[key] || []).push(r);
    }
    for (const [key, group] of Object.entries(byType)) {
      let bal = 0;
      const firstId = group[0].id;
      const before = db.get(t === 'drawer_log'
        ? `SELECT amount FROM ${t} WHERE drawer_type = ? AND id < ? ORDER BY id DESC LIMIT 1`
        : `SELECT amount FROM ${t} WHERE id < ? ORDER BY id DESC LIMIT 1`, t === 'drawer_log' ? [key, firstId] : [firstId]);
      bal = before ? Number(before.amount) : 0;
      const rest = db.all(t === 'drawer_log'
        ? `SELECT id, amount FROM ${t} WHERE drawer_type = ? AND id > ? ORDER BY id`
        : `SELECT id, amount FROM ${t} WHERE id > ? ORDER BY id`, t === 'drawer_log' ? [key, group[group.length - 1].id] : [group[group.length - 1].id]);
      for (const r of rest) {
        db.run(`UPDATE ${t} SET balance = ? WHERE id = ?`, [bal, r.id]);
        bal += Number(r.amount);
      }
    }
    touched.push(`${t}:${rows.length}`);
  }
  return touched;
}

// --- deleting a whole operation by its reference (returns cleanup) ---
ipcMain.handle('cash-deleteByReference', (_, referenceId) => {
  const ref = String(referenceId || '');
  if (!ref) throw new Error('مرجع غير صالح');
  const touched = db.transaction(() => deleteCashByReference(ref));
  return { success: true, removed: touched };
});

// --- invoice cancel (invoices.cancel) ---
// Reverses the drawer, returns stock (respecting container compositions) and
// drops the returns rows, all in one transaction so a failure leaves no half
// cancelled invoice behind.
ipcMain.handle('invoice-cancel', (_, id) => {
  const u = requirePerm('invoices', 'cancel');
  const saleId = parseInt(id, 10);
  const sale = saleId ? db.get('SELECT * FROM sales WHERE id = ?', [saleId]) : null;
  if (!sale) return { success: false, message: 'الفاتورة غير موجودة' };

  const links = db.all('SELECT * FROM product_compositions');
  const containerOf = {};
  for (const l of links) containerOf[l.container_id] = { unitId: l.unit_id, unitsPerContainer: l.units_per_container };
  function syncContainers(unitId) {
    for (const cid of Object.keys(containerOf)) {
      const link = containerOf[cid];
      if (link.unitId !== unitId) continue;
      const unit = db.get('SELECT stock FROM products WHERE id = ?', [unitId]);
      const derived = Math.floor((unit ? unit.stock : 0) / link.unitsPerContainer);
      db.run('UPDATE products SET stock = ? WHERE id = ?', [derived, cid]);
    }
  }
  function adjustStock(productId, qtyDelta) {
    const link = containerOf[productId];
    if (link) {
      db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [qtyDelta * link.unitsPerContainer, link.unitId]);
      syncContainers(link.unitId);
    } else {
      db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [qtyDelta, productId]);
      syncContainers(productId);
    }
  }
  const dtMap = { cash: 'نقدي', vodafone: 'فودافون كاش', instapay: 'انستاباي' };
  const reversals = [];
  if (sale.payment_breakdown) {
    try {
      const bd = JSON.parse(sale.payment_breakdown);
      for (const [k, v] of Object.entries(bd)) if (Number(v) > 0) reversals.push([dtMap[k] || k, -Number(v)]);
    } catch (e) {
      if (sale.paid_amount > 0) reversals.push([dtMap[sale.payment_method] || 'نقدي', -sale.paid_amount]);
    }
  } else if (sale.paid_amount > 0) {
    reversals.push([dtMap[sale.payment_method] || 'نقدي', -sale.paid_amount]);
  }

  db.transaction(() => {
    for (const [type, amount] of reversals) recordDrawer(u.id, type, amount, 'إلغاء فاتورة ' + sale.invoice_number);
    const items = db.all('SELECT product_id, quantity FROM sale_items WHERE sale_id = ?', [saleId]);
    for (const item of items) adjustStock(item.product_id, item.quantity);
    const rets = db.all('SELECT id, product_id, quantity, destination, document_id FROM returns WHERE sale_id = ?', [saleId]);
    for (const r of rets) {
      if (r.destination === 'مخزون') adjustStock(r.product_id, -r.quantity);
      else if (r.destination === 'مصنع') adjustStock(r.product_id, r.quantity);
      db.run('DELETE FROM returns WHERE id = ?', [r.id]);
    }
    // The return invoices have to go as well, together with the money they moved.
    // Deleting only the lines left the header row and its cash row behind, so
    // cancelling a sale still left a "return" pointing at nothing.
    for (const did of new Set(rets.map(r => r.document_id).filter(v => v))) {
      deleteCashByReference('returndoc:' + did);
      db.run('DELETE FROM return_documents WHERE id = ?', [did]);
    }
    for (const r of rets) deleteCashByReference('return:' + r.id);
    db.run('DELETE FROM sales WHERE id = ?', [saleId]);
  });

  db.auditLog(u.id, 'إلغاء فاتورة', String(sale.invoice_number));
  return { success: true };
});

ipcMain.handle('cash-getBalance', () => { requireAuth();  const cash = db.get("SELECT balance FROM drawer_log WHERE drawer_type='نقدي' ORDER BY id DESC LIMIT 1");
  const vf = db.get("SELECT balance FROM drawer_log WHERE drawer_type='فودافون كاش' ORDER BY id DESC LIMIT 1");
  const ip = db.get("SELECT balance FROM drawer_log WHERE drawer_type='انستاباي' ORDER BY id DESC LIMIT 1");
  const treasury = db.get("SELECT balance FROM treasury_log ORDER BY id DESC LIMIT 1");
  return {
    drawer_cash: cash ? cash.balance : 0,
    drawer_vodafone: vf ? vf.balance : 0,
    drawer_instapay: ip ? ip.balance : 0,
    treasury: treasury ? treasury.balance : 0
  };
});

// A4 return sheet. Returns are a different document from a sale invoice: the
// drawer moves the other way, the money often clears a supplier debt instead of
// being handed over, and it is filed rather than given to the customer, so the
// thermal receipt layout is the wrong shape for it.
ipcMain.handle('print-return', (_, docId) => {
  requireAuth();
  const { BrowserWindow } = require('electron');
  const id = parseInt(docId, 10);
  const doc = Number.isInteger(id) ? db.get('SELECT * FROM return_documents WHERE id = ?', [id]) : null;
  if (!doc) throw new Error('المرتجع مش موجود');

  const lines = db.all(
    'SELECT r.product_id, r.quantity, r.amount, p.name AS product_name FROM returns r LEFT JOIN products p ON p.id = r.product_id WHERE r.document_id = ? ORDER BY r.id',
    [id]);
  const items = lines.map(l => {
    const qty = Number(l.quantity) || 0;
    // amount is the line total, so the unit price has to come back out of it.
    return { name: l.product_name || '-', qty, price: qty ? Number(l.amount) / qty : 0 };
  });
  const usr = doc.user_id ? db.get('SELECT full_name, username FROM users WHERE id = ?', [doc.user_id]) : null;
  const cashAmount = Number(doc.cash_amount) || 0;

  const printWin = new BrowserWindow({
    width: 820, height: 1000, show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });
  const q = new URLSearchParams({
    type: doc.type,
    number: doc.return_number || '',
    source: doc.source_invoice || '',
    total: Number(doc.total) || 0,
    debt: Number(doc.debt_reduced) || 0,
    cash: cashAmount,
    pool: doc.cash_pool || '',
    reason: doc.reason || '',
    user: (usr && (usr.full_name || usr.username)) || '-',
    date: doc.created_at || '',
    shop: db.getSetting('shop_name') || 'الكاشير',
    phone: db.getSetting('shop_phone') || '',
    address: db.getSetting('shop_address') || '',
    items: encodeURIComponent(JSON.stringify(items))
  });
  printWin.loadURL(`file://${path.join(__dirname, 'src', 'print-return.html')}?${q.toString()}`);
  printWin.once('ready-to-show', () => { printWin.show(); printWin.focus(); });
  printWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      // A4 explicitly: without pageSize the sheet follows the default paper of
      // whatever printer is installed, which came out 80mm on thermal setups.
      printWin.webContents.print({ silent: false, pageSize: 'A4' }, () => printWin.close());
    }, 300);
  });
});

ipcMain.handle('print-invoice', (_, data) => {
  requireAuth();
  const { BrowserWindow } = require('electron');
  const printerSize = db.getSetting('printer_size') || '80mm';
  const width = printerSize === '56mm' ? 300 : 450;
  const printWin = new BrowserWindow({
    width, height: 700, show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });
  const itemsEncoded = encodeURIComponent(JSON.stringify(data.items || []));
  const shopName = db.getSetting('shop_name') || 'الكاشير';
  const shopPhone = db.getSetting('shop_phone') || '';
  const method = data.method || 'نقدي';
  const discount = data.discount || 0;
  const discountPct = data.discountPct || 0;
  const saleDate = data.saleDate || '';
  const paymentBreakdown = data.payment_breakdown || '';
  printWin.loadURL(`file://${path.join(__dirname, 'src', 'print.html')}?invoice=${encodeURIComponent(data.invoice || '')}&total=${data.total || 0}&paid=${data.paid || 0}&printer=${printerSize}&items=${itemsEncoded}&shop=${encodeURIComponent(shopName)}&phone=${encodeURIComponent(shopPhone)}&method=${encodeURIComponent(method)}&customer=${encodeURIComponent(data.customer || '')}&barcode=${encodeURIComponent(data.barcode || '')}&cashier=${encodeURIComponent(data.cashier || '')}&discount=${discount}&discountPct=${discountPct}&saleDate=${encodeURIComponent(saleDate)}&payment_breakdown=${encodeURIComponent(paymentBreakdown)}`);
  printWin.once('ready-to-show', () => {
    printWin.show();
    printWin.focus();
  });
  printWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      printWin.webContents.print({}, () => printWin.close());
    }, 300);
  });
});

// The live database lives in app.getPath('userData'), NOT in ./database (that
// path is only the legacy pre-migration location).
function liveDbPath() {
  return path.join(app.getPath('userData'), 'clothes.db');
}

function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

ipcMain.handle('backup-create', () => {
  const g = adminGate(); if (g.error) return g.error;
  const fs = require('fs');
  const src = liveDbPath();
  if (!fs.existsSync(src)) return { success: false, message: 'ملف قاعدة البيانات غير موجود' };
  const fileName = `clothes_backup_${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`;
  const dir = backupsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  // Checkpoint first so the copy is internally consistent (WAL mode).
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(src, dest);
  return { success: true, fileName };
});

ipcMain.handle('backup-restore', (_, filePath) => {
  const g = adminGate(); if (g.error) return g.error;
  const actor = g.user;
  const fs = require('fs');
  const Database = require('better-sqlite3');
  const src = String(filePath || '');
  if (!src || !fs.existsSync(src)) return { success: false, message: 'ملف النسخة غير موجود' };
  // Only accept a real SQLite database - refuse anything else before we overwrite.
  try {
    const probe = new Database(src, { readonly: true, fileMustExist: true });
    const isDb = probe.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='users'").get();
    probe.close();
    if (!isDb || !isDb.c) return { success: false, message: 'الملف ده مش نسخة احتياطية صالحة' };
  } catch (e) {
    return { success: false, message: 'الملف ده مش قاعدة بيانات صالحة' };
  }
  const dest = liveDbPath();
  const dir = backupsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safety = path.join(dir, `pre_restore_${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`);
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  if (fs.existsSync(dest)) fs.copyFileSync(dest, safety);
  fs.copyFileSync(src, dest);
  db.auditLog(actor.id, 'استرجاع نسخة', `استرجع من ${path.basename(src)}`);
  return { success: true, message: 'تم الاسترجاع. اقفل البرنامج وافتحه تاني.' };
});

ipcMain.handle('backup-list', () => {
  requireAuth();
  const fs = require('fs');
  const dir = backupsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { name: f, path: path.join(dir, f), size: stat.size, date: stat.mtime };
  }).sort((a, b) => b.date - a.date);
  return files;
});

ipcMain.handle('backup-select-file', async () => {
  requireAuth();
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Database', extensions: ['db'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('currency-getDefault', () => {
  requireAuth();
  return db.getDefaultCurrency();
});

ipcMain.handle('currency-getAll', () => {
  requireAuth();
  return db.all('SELECT * FROM currencies ORDER BY is_default DESC, name');
});

ipcMain.handle('currency-setDefault', (_, id) => {
  const g = adminGate(); if (g.error) return g.error;
  db.run('UPDATE currencies SET is_default = 0');
  db.run('UPDATE currencies SET is_default = 1 WHERE id = ?', [id]);
  return { success: true };
});

ipcMain.handle('currency-add', (_, code, name, symbol, rate) => {
  const g = adminGate(); if (g.error) return g.error;
  const existing = db.get('SELECT id FROM currencies WHERE code = ?', [code]);
  if (existing) return { success: false, message: 'رمز العملة موجود بالفعل' };
  db.run('INSERT INTO currencies (code, name, symbol, exchange_rate) VALUES (?,?,?,?)', [code, name, symbol, rate]);
  return { success: true };
});

ipcMain.handle('currency-delete', (_, id) => {
  const g = adminGate(); if (g.error) return g.error;
  const cur = db.get('SELECT is_default FROM currencies WHERE id = ?', [id]);
  if (cur?.is_default) return { success: false, message: 'لا يمكن حذف العملة الافتراضية' };
  db.run('DELETE FROM currencies WHERE id = ?', [id]);
  return { success: true };
});

app.whenReady().then(() => {
  const userDir = app.getPath('userData');
  createWindow(userDir);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Closing the app logs the user out: the main-process session is dropped and
// session.json is deleted, so the next launch starts at the login form. The
// renderer's localStorage copy is cleared too, otherwise the sidebar would keep
// treating the closed app as signed in until the next real login overwrites it.
app.on('before-quit', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        "try { localStorage.removeItem('user'); localStorage.removeItem('loginTime'); } catch (e) {}");
    }
  } catch (e) { /* window already gone */ }
  sessionUserId = null;
  persistSession();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(app.getPath('userData'));
});
