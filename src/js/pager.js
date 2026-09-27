// Shared pager for the long list tables (invoices, products, cash, ...).
//
// These pages used to render their whole result set into innerHTML. Even with a
// 118ms query, 10k invoices took ~61s of DOM work, so every list now asks
// SQLite for one page at a time (LIMIT/OFFSET) and this draws the navigation.
// The page script only builds its WHERE clause and calls render(total).
//
// Loaded before the page's own <script> so window.TablePager exists.
(function (global) {
  'use strict';

  let seq = 0;

  function create(opts) {
    const size = opts.size || 20;
    const container = document.getElementById(opts.container);
    const label = opts.label || 'صفحة';
    let page = 1;
    let lastFilterKey = null;
    let onGo = opts.onGo || null;

    // One global per instance so several pagers can coexist on a page and the
    // generated onclick handlers never collide.
    const goFn = '__pagerGo' + (++seq);
    global[goFn] = function (n) {
      page = Math.max(1, parseInt(n, 10) || 1);
      if (onGo) onGo(page);
    };

    return {
      size: size,
      get page() { return page; },
      get limit() { return size; },
      get offset() { return (page - 1) * size; },

      // A changed search/filter has to land on page 1, otherwise you end up on
      // page 40 of a result set that only has one page. Call before the query.
      // The first call just records the key so the initial load keeps page 1.
      syncFilter(key) {
        if (lastFilterKey !== null && lastFilterKey !== key) page = 1;
        lastFilterKey = key;
        return page;
      },

      // Deleting the last row of the last page must not strand you on page 99.
      // Call after counting, before the LIMIT/OFFSET query.
      clamp(total) {
        const pages = Math.max(1, Math.ceil(total / size));
        if (page > pages) page = pages;
        return page;
      },

      go(n) { global[goFn](n); },

      render(total) {
        if (!container) return;
        const pages = Math.max(1, Math.ceil(total / size));
        // Nothing to navigate when everything fits on one page.
        if (total <= size) { container.innerHTML = ''; return; }

        const cur = page;
        const from = (cur - 1) * size + 1;
        const to = Math.min(total, cur * size);
        const dis = 'disabled style="opacity:.4;cursor:not-allowed"';

        // page-number window around the current page, with ellipses for the gap
        const nums = [];
        const push = function (n) { if (n >= 1 && n <= pages && nums.indexOf(n) === -1) nums.push(n); };
        push(1); push(2);
        for (let n = cur - 1; n <= cur + 1; n++) push(n);
        push(pages - 1); push(pages);
        nums.sort(function (a, b) { return a - b; });

        let btns = '';
        let prev = 0;
        for (const n of nums) {
          if (prev && n - prev > 1) btns += '<span style="color:var(--text-secondary);padding:0 2px">…</span>';
          const on = n === cur ? 'background:var(--primary);color:#fff;border-color:var(--primary);font-weight:700' : '';
          btns += `<button class="btn btn-sm" onclick="${goFn}(${n})" style="min-width:34px;${on}">${n}</button>`;
          prev = n;
        }

        container.innerHTML =
          `<button class="btn btn-sm" onclick="${goFn}(${cur - 1})" ${cur <= 1 ? dis : ''}>‹ السابق</button>` +
          btns +
          `<button class="btn btn-sm" onclick="${goFn}(${cur + 1})" ${cur >= pages ? dis : ''}>التالي ›</button>` +
          `<span style="color:var(--text-secondary);font-size:12px;margin-inline-start:8px">${from}–${to} من ${total.toLocaleString()} ${label} (${pages.toLocaleString()} صفحة)</span>`;
      }
    };
  }

  global.TablePager = { create: create };
})(window);
