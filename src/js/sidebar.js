window.currencySymbol = 'ج.م';

window.showAlert = function(msg, type) {
  type = type || 'success';
  const el = document.createElement('div');
  el.className = 'notification ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
};

window.showPrompt = function(label, defaultValue) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div class="modal" style="text-align:center;"><h2>' + label + '</h2><input type="number" id="promptInput" class="form-control" style="width:100%;margin:12px 0;padding:8px;font-size:16px;border:2px solid var(--primary);border-radius:6px;text-align:center" value="' + (defaultValue || 0) + '" autofocus><div style="display:flex;gap:8px"><button class="btn btn-primary" id="promptOk" style="flex:1">موافق</button><button class="btn" style="background:var(--border);flex:1" id="promptCancel">إلغاء</button></div></div>';
    document.body.appendChild(overlay);
    var input = document.getElementById('promptInput');
    input.focus();
    input.select();
    function cleanup() { overlay.remove(); }
    document.getElementById('promptOk').onclick = function() { var val = input.value; cleanup(); resolve(val ? parseFloat(val) : null); };
    document.getElementById('promptCancel').onclick = function() { cleanup(); resolve(null); };
    overlay.onclick = function(e) { if (e.target === overlay) { cleanup(); resolve(null); } };
    input.onkeydown = function(e) { if (e.key === 'Enter') { document.getElementById('promptOk').click(); } };
  });
};

window.showConfirm = function(msg) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div class="modal" style="text-align:center;"><h2>تأكيد</h2><p style="margin:16px 0;font-size:16px;">' + msg + '</p><button class="btn btn-primary" id="confirmYes">نعم</button><button class="btn" style="background:var(--border);margin-top:8px;" id="confirmNo">إلغاء</button></div>';
    document.body.appendChild(overlay);
    document.getElementById('confirmYes').onclick = function() { overlay.remove(); resolve(true); };
    document.getElementById('confirmNo').onclick = function() { overlay.remove(); resolve(false); };
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
};

(async function loadCurrencySymbol() {
  try {
    const cur = await window.api.currency.getDefault();
    if (cur && cur.symbol) window.currencySymbol = cur.symbol;
  } catch(e) {}
})();

if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-mode');

// Global permission helper
window.can = function(page, action) {
  const u = JSON.parse(localStorage.getItem('user') || '{}');
  if (u.role === 'admin') return true;
  if (!u.permissions) return false;
  try {
    const perms = typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions;
    return !!(perms[page] && perms[page][action] === true);
  } catch(e) { return false; }
};

// Hide elements the current role may not use. Cosmetic only - every action is
// re-checked in main, which is the actual boundary. Mark an element with
// data-need="module.action" to have it hidden automatically.
window.hideUnless = function (perm, action) {
  if (window.can(perm, action)) return;
  document.querySelectorAll(`[data-need="${perm}.${action}"]`).forEach(el => {
    el.style.display = 'none';
  });
};

// Same idea but for elements addressed by id, for legacy pages without markers.
window.applyPermGates = function (gates) {
  (gates || []).forEach(([perm, action, ids]) => {
    if (window.can(perm, action)) return;
    (ids || []).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  });
};
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason || '');
  if (!msg) return;
  e.preventDefault();
  if (/انتهت الجلسة/.test(msg)) {
    localStorage.removeItem('user');
    localStorage.removeItem('loginTime');
    window.location.href = 'login.html';
    return;
  }
  if (window.showAlert) window.showAlert(msg, 'error');
  else console.error(msg);
});

// Escape helper - use this for ANY value coming from the database before it
// touches innerHTML, otherwise a name like <img onerror=...> runs script.
window.esc = function (v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// Page-level access control
// Mirrors PAGE_MODULE in main.js. Every guarded page needs an entry here or the
// link will be shown to someone main will then refuse to open.
const pageMap = {
  'dashboard.html': null,
  'pos.html': 'pos',
  'invoices.html': 'invoices',
  'returns.html': 'returns',
  'products.html': 'products',
  'categories.html': 'categories',
  'promotions.html': 'promotions',
  'purchases.html': 'purchases',
  'customers.html': 'customers',
  'suppliers.html': 'suppliers',
  'expenses.html': 'expenses',
  'cash.html': 'cash',
  'shifts.html': 'shifts',
  'reports.html': 'reports',
  'users.html': 'users',
  'backup.html': 'backup',
  'settings.html': 'settings'
};

// Where to land when the current page is not allowed. Ordered by how much a
// user normally needs, and every entry is checked before we go there - sending
// someone to a page they also cannot see is what caused an endless reload.
const FALLBACK_ORDER = ['pos.html', 'products.html', 'invoices.html', 'customers.html', 'reports.html', 'dashboard.html'];

window.firstAllowedPage = function (except) {
  return FALLBACK_ORDER.find(p => p !== except && (!pageMap[p] || window.can(pageMap[p], 'v'))) || null;
};

// Page view is enforced in main's navigate handler. This is only the fast
// UI redirect so a user without the permission does not see a page flash.
const currentFile = window.location.pathname.split('/').pop();
if (currentFile !== 'login.html' && currentFile !== 'setup.html' && !localStorage.getItem('user')) {
  window.location.replace('login.html');
} else {
  const requiredPerm = pageMap[currentFile];
  if (requiredPerm && !window.can(requiredPerm, 'v')) {
    // A stale localStorage copy is the usual cause. Ask main for the truth so
    // the next load starts from the same permissions it actually enforces.
    if (window.api && window.api.auth && window.api.auth.me) {
      window.api.auth.me().then(fresh => {
        if (fresh && fresh.role !== 'admin') {
          localStorage.setItem('user', JSON.stringify(fresh));
        }
      }).catch(() => {});
    }
    const landing = window.firstAllowedPage(currentFile);
    if (landing) {
      // replace, not href: the denied page must not stay in history or the
      // back button walks straight back into it.
      window.location.replace(landing);
    } else {
      // No page at all is open to this user. Sign them out instead of
      // redirecting, otherwise there is nowhere left to go.
      localStorage.removeItem('user');
      localStorage.removeItem('loginTime');
      window.location.replace('login.html');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const currentPage = window.location.pathname.split('/').pop();

  const links = [
    { section: 'المبيعات', links: [
      { href: 'pos.html', icon: '🛒', label: 'نقطة البيع' },
      { href: 'invoices.html', icon: '📋', label: 'الفواتير' },
      { href: 'returns.html', icon: '↩️', label: 'المرتجعات' },
      { href: 'promotions.html', icon: '🎯', label: 'العروض' }
    ] },
    { section: 'المخزون', links: [
      { href: 'products.html', icon: '📦', label: 'المنتجات' },
      { href: 'categories.html', icon: '🏷️', label: 'التصنيفات' },
      { href: 'purchases.html', icon: '📥', label: 'المشتريات' }
    ] },
    { section: 'الإدارة', links: [
      { href: 'customers.html', icon: '👤', label: 'العملاء' },
      { href: 'suppliers.html', icon: '📦', label: 'الموردين' },
      { href: 'expenses.html', icon: '💰', label: 'المصروفات' },
      { href: 'shifts.html', icon: '🕐', label: 'الشيفتات' },
      { href: 'cash.html', icon: '🏦', label: 'الخزينة' }
    ] },
    { section: 'التقارير', links: [
      { href: 'reports.html', icon: '📈', label: 'التقارير' }
    ] },
    { section: 'النظام', links: [
      { href: 'users.html', icon: '👥', label: 'المستخدمين' },
      { href: 'backup.html', icon: '💾', label: 'النسخ الاحتياطي' },
      { href: 'settings.html', icon: '⚙️', label: 'الإعدادات' }
    ] }
  ];

  let navHTML = '';
  links.forEach(group => {
    navHTML += `<div class="nav-section">${group.section}</div>`;
    group.links.forEach(link => {
      // pageMap covers every guarded page, so the link disappears whenever the
      // main-process navigate would refuse to open it.
      const permKey = pageMap[link.href];
      if (permKey && !window.can(permKey, 'v')) return;
      const active = currentPage === link.href ? ' class="active"' : '';
      navHTML += `<a href="${link.href}"${active}><span class="icon">${link.icon}</span> ${link.label}</a>`;
    });
  });

  document.querySelector('.sidebar nav').innerHTML = navHTML;

  const user = JSON.parse(localStorage.getItem('user'));
  if (user) {
    document.getElementById('userNameDisplay').textContent = user.full_name;
    document.getElementById('userRoleDisplay').textContent =
      user.role === 'admin' ? 'مدير' : user.role === 'cashier' ? 'كاشير' : 'مخزني';
    document.getElementById('userAvatar').textContent = user.full_name.charAt(0);
    const loginTime = localStorage.getItem('loginTime');
    if (loginTime) {
      const d = new Date(loginTime);
      const timeStr = d.toLocaleString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      document.getElementById('userRoleDisplay').textContent += ` — ${timeStr}`;
    }
  }

  document.getElementById('logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    // Clear the authoritative session in the main process, not just localStorage.
    try { await window.api.auth.logout(); } catch (e) { /* already gone */ }
    localStorage.removeItem('user');
    localStorage.removeItem('loginTime');
    window.location.href = 'login.html';
  });

  const logoDiv = document.querySelector('.sidebar .logo');
  if (logoDiv) {
    logoDiv.innerHTML = '<img src="../../assets/images/logo.png" style="height:45px;width:auto;display:block;margin:4px auto;" alt="Logo">';
  }

  if (currentPage !== 'pos.html') {
    const footer = document.createElement('div');
    footer.style.cssText = 'text-align:center;padding:12px 16px;font-size:11px;color:var(--text-secondary);border-top:1px solid var(--border);margin-top:16px;';
    footer.innerHTML = 'شركة Codex Controle &nbsp;|&nbsp; 01008997337';
    document.querySelector('.main-content').appendChild(footer);
  }

  // Shop name no longer displayed in sidebar (logo image used instead)
});
