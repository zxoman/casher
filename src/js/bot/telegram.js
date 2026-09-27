const db = require('../database');

let bot = null;
let isEnabled = false;

function initialize() {
  const token = db.getSetting('telegram_token');

  if (!token) {
    isEnabled = false;
    return;
  }

  try {
    const TelegramBotAPI = require('node-telegram-bot-api');
    bot = new TelegramBotAPI(token, { polling: true });
    isEnabled = true;

    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id.toString();
      db.setSetting('telegram_chat_id', chatId);
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      bot.sendMessage(chatId, `👋 مرحباً بك في بوت نظام الكاشير\n📅 ${now}\n✅ تم حفظ معرف الشات (${chatId}) بنجاح\n\nالأوامر المتاحة:\n/report - التقرير العام\n/sales - مبيعات اليوم\n/profit - أرباح اليوم\n/stock - المخزون المنخفض\n/expenses - مصروفات اليوم\n/cash - رصيد الخزينة\n/last - آخر 5 عمليات`);
    });

    bot.onText(/\/sales/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const data = await db.get("SELECT COALESCE(SUM(total_amount),0) as total FROM sales WHERE date(created_at) = date('now')");
      const count = await db.get("SELECT COUNT(*) as count FROM sales WHERE date(created_at) = date('now')");
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      bot.sendMessage(msg.chat.id, `📊 مبيعات اليوم - ${now}:\n💰 الإجمالي: ${Number(data.total).toLocaleString()} ج.م\n📄 عدد الفواتير: ${count.count}`);
    });

    bot.onText(/\/profit/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const profit = await db.get("SELECT COALESCE(SUM(si.total - (si.quantity * p.buy_price)),0) as profit FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id WHERE date(s.created_at) = date('now')");
      const expenses = await db.get("SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date(created_at) = date('now')");
      const net = profit.profit - expenses.total;
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      bot.sendMessage(msg.chat.id, `📈 أرباح اليوم - ${now}:\n✅ الربح الإجمالي: ${Number(profit.profit).toLocaleString()} ج.م\n❌ المصروفات: ${Number(expenses.total).toLocaleString()} ج.م\n🔵 صافي الربح: ${net.toLocaleString()} ج.م`);
    });

    bot.onText(/\/stock/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const low = await db.all("SELECT name, stock FROM products WHERE stock <= min_stock ORDER BY name ASC LIMIT 10");
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      if (low.length === 0) {
        bot.sendMessage(msg.chat.id, `✅ المخزون جيد - ${now}، لا توجد منتجات منخفضة`);
      } else {
        const list = low.map(p => `- ${p.name}: المخزون ${p.stock||0}`).join('\n');
        bot.sendMessage(msg.chat.id, `⚠️ منتجات منخفضة المخزون - ${now}:\n${list}`);
      }
    });

    bot.onText(/\/expenses/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const data = await db.get("SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date(created_at) = date('now')");
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      bot.sendMessage(msg.chat.id, `💰 مصروفات اليوم - ${now}: ${Number(data.total).toLocaleString()} ج.م`);
    });

    bot.onText(/\/cash/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const drawerCash = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='نقدي' ORDER BY id DESC LIMIT 1");
      const drawerVf = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='فودافون كاش' ORDER BY id DESC LIMIT 1");
      const drawerIp = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='انستاباي' ORDER BY id DESC LIMIT 1");
      const treasury = await db.get("SELECT balance FROM treasury_log ORDER BY id DESC LIMIT 1");
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const msgText = `🏦 الحسابات - ${now}:
💰 الدرج (نقدي): ${(drawerCash?.balance||0).toLocaleString()} ج.م
📱 الدرج (فودافون كاش): ${(drawerVf?.balance||0).toLocaleString()} ج.م
💳 الدرج (انستاباي): ${(drawerIp?.balance||0).toLocaleString()} ج.م
💵 الخزينة: ${(treasury?.balance||0).toLocaleString()} ج.م`;
      bot.sendMessage(msg.chat.id, msgText);
    });

    bot.onText(/\/last/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const sales = await db.all("SELECT invoice_number, total_amount FROM sales ORDER BY created_at DESC LIMIT 5");
      const now = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const list = sales.map(s => `🛒 فاتورة ${s.invoice_number}: ${Number(s.total_amount).toLocaleString()} ج.م`).join('\n');
      bot.sendMessage(msg.chat.id, `📋 آخر المبيعات - ${now}:\n${list || 'لا توجد مبيعات'}`);
    });

    bot.onText(/\/report/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const opts = {
        reply_markup: {
          keyboard: [['📅 اليوم', '📆 الشهر', '📅 السنة']],
          one_time_keyboard: true,
          resize_keyboard: true
        }
      };
      bot.sendMessage(msg.chat.id, '📊 اختر الفترة للتقرير العام:', opts);
    });

    bot.onText(/^(📅 اليوم|📆 الشهر|📅 السنة)$/, async (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      const choice = msg.text;
      const now = new Date();
      const dateStr = now.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const today = now.toISOString().split('T')[0];
      let from, periodLabel;

      if (choice === '📅 اليوم') {
        from = today;
        periodLabel = 'اليوم';
      } else if (choice === '📆 الشهر') {
        from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        periodLabel = 'الشهر';
      } else {
        from = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
        periodLabel = 'السنة';
      }

      const [
        salesData,
        costData, expensesData,
        purchasesData, profitData,
        productsCount, lowStockCount,
        customersCount, suppliersCount,
        customerDebt, supplierDebt,
        returnsData, returnsCost
      ] = await Promise.all([
        db.get("SELECT COALESCE(SUM(total_amount),0) as t, COUNT(*) as c FROM sales WHERE date(created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COALESCE(SUM(si.quantity * p.buy_price),0) as t FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id WHERE date(s.created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE date(created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COALESCE(SUM(total_amount),0) as t FROM purchases WHERE date(created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COALESCE(SUM(si.total - (si.quantity * p.buy_price)),0) as profit FROM sale_items si JOIN products p ON si.product_id = p.id JOIN sales s ON si.sale_id = s.id WHERE date(s.created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COUNT(*) as c FROM products"),
        db.get("SELECT COUNT(*) as c FROM products WHERE stock <= min_stock"),
        db.get("SELECT COUNT(*) as c FROM customers"),
        db.get("SELECT COUNT(*) as c FROM suppliers"),
        db.get("SELECT COALESCE(SUM(remaining_amount),0) as t FROM sales WHERE remaining_amount>0"),
        db.get("SELECT COALESCE(SUM(remaining_amount),0) as t FROM purchases WHERE remaining_amount>0"),
        db.get("SELECT COALESCE(SUM(amount),0) as t FROM returns WHERE date(created_at) BETWEEN ? AND ?", [from, today]),
        db.get("SELECT COALESCE(SUM(r.quantity * COALESCE(p.buy_price, 0)), 0) as t FROM returns r LEFT JOIN products p ON r.product_id = p.id WHERE date(r.created_at) BETWEEN ? AND ?", [from, today])
      ]);

      const netSales = salesData.t - returnsData.t;
      const netCost = costData.t - returnsCost.t;
      const drawerCash = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='نقدي' ORDER BY id DESC LIMIT 1");
      const drawerVf = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='فودافون كاش' ORDER BY id DESC LIMIT 1");
      const drawerIp = await db.get("SELECT balance FROM drawer_log WHERE drawer_type='انستاباي' ORDER BY id DESC LIMIT 1");
      const drawerBal = (drawerCash?.balance||0) + (drawerVf?.balance||0) + (drawerIp?.balance||0);
      const netProfit = profitData.profit - expensesData.t - returnsData.t + returnsCost.t;

      const topProducts = await db.all("SELECT p.name, SUM(si.quantity) as qty FROM sale_items si JOIN products p ON si.product_id = p.id GROUP BY si.product_id ORDER BY qty DESC LIMIT 5");
      const topList = topProducts.map(t => `• ${t.name}: ${t.qty}`).join('\n');

      const msgText = `📊 التقرير العام - ${periodLabel}\n${dateStr}

💵 صافي المبيعات: ${Number(netSales).toLocaleString()} ج.م (${salesData.c} فاتورة)
↩️ المرتجعات: -${Number(returnsData.t).toLocaleString()} ج.م
📦 المشتريات: ${Number(purchasesData.t).toLocaleString()} ج.م
💰 المصروفات: ${Number(expensesData.t).toLocaleString()} ج.م
📉 صافي تكلفة المبيعات: ${Number(netCost).toLocaleString()} ج.م
📈 صافي الربح: ${netProfit.toLocaleString()} ج.م

━━━ 📊 الإحصائيات ━━━
📦 المنتجات: ${productsCount.c} | ⚠️ منخفض: ${lowStockCount.c}
👤 العملاء: ${customersCount.c} | الموردين: ${suppliersCount.c}
💰 رصيد الدرج: ${drawerBal.toLocaleString()} ج.م
⚖️ ديون العملاء: ${Number(customerDebt.t).toLocaleString()} ج.م
⚖️ ديون الموردين: ${Number(supplierDebt.t).toLocaleString()} ج.م

━━━ 🏆 الأكثر مبيعاً ━━━
${topList || 'لا توجد مبيعات'}`;

      bot.sendMessage(msg.chat.id, msgText, { reply_markup: { remove_keyboard: true } });
    });

    bot.on('message', (msg) => {
      if (!isAuthorized(msg.chat.id)) return;
      if (!msg.text) return;
      if (msg.text.startsWith('/')) return;
      if (/^(📅 اليوم|📆 الشهر|📅 السنة)$/.test(msg.text)) return;
      bot.sendMessage(msg.chat.id, `👋 مرحباً! الأوامر المتاحة:\n/report - التقرير العام\n/sales - مبيعات اليوم\n/profit - أرباح اليوم\n/stock - المخزون المنخفض\n/expenses - مصروفات اليوم\n/cash - رصيد الخزينة\n/last - آخر 5 عمليات`);
    });

    console.log('✅ Telegram bot initialized');
  } catch (err) {
    console.log('❌ Telegram bot failed:', err.message);
    isEnabled = false;
  }
}

function isAuthorized(chatId) {
  const savedChatId = db.getSetting('telegram_chat_id');
  return chatId.toString() === savedChatId;
}

function sendNotification(type, data) {
  if (!isEnabled || !bot) return;
  const chatId = db.getSetting('telegram_chat_id');
  if (!chatId) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let message = '';
  switch(type) {
    case 'sale':
      const saleRemaining = data.remaining || 0;
      message = `🛒 عملية بيع جديدة\n📄 الفاتورة: ${data.invoice}\n👤 العميل: ${data.customer || 'نقدي'}\n💰 الإجمالي: ${Number(data.total).toLocaleString()} ج.م\n💵 المدفوع: ${Number(data.paid || data.total).toLocaleString()} ج.م\n📋 المتبقي: ${Number(saleRemaining).toLocaleString()} ج.م\n💳 طريقة الدفع: ${data.method || 'نقدي'}\n📦 ${data.details}\n📅 ${dateStr}`;
      break;
    case 'purchase':
      const purRemaining = data.remaining || 0;
      message = `📥 فاتورة شراء جديدة\n📄 رقم: ${data.invoice}\n🏭 المورد: ${data.supplier || '-'}\n💰 الإجمالي: ${Number(data.total).toLocaleString()} ج.م\n💵 المدفوع: ${Number(data.paid || 0).toLocaleString()} ج.م\n📋 المتبقي: ${Number(purRemaining).toLocaleString()} ج.م\n💳 جهة الدفع: ${data.paymentSource || 'نقدي'}\n📅 ${dateStr}`;
      break;
    case 'expense':
      message = `💰 مصروف جديد\n📝 ${data.description}\n💵 المبلغ: ${Number(data.amount).toLocaleString()} ج.م\n📅 ${dateStr}`;
      break;
    case 'login':
      message = `🔓 تسجيل دخول جديد\n👤 المستخدم: ${data.user}\n📅 ${dateStr}`;
      break;
    case 'customer':
      message = `👤 عميل جديد\nالاسم: ${data.name}\n📞 ${data.phone || 'لا يوجد هاتف'}\n📅 ${dateStr}`;
      break;
  }

  if (message) {
    bot.sendMessage(chatId, message).catch(() => {});
  }
}

module.exports = { initialize, sendNotification };
