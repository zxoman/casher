const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  db: {
    get: (sql, params) => ipcRenderer.invoke('db-get', sql, params),
    all: (sql, params) => ipcRenderer.invoke('db-all', sql, params),
    run: (sql, params) => ipcRenderer.invoke('db-run', sql, params),
    getSetting: (key) => ipcRenderer.invoke('db-getSetting', key),
    setSetting: (key, value) => ipcRenderer.invoke('db-setSetting', key, value),
  },

  auth: {
    login: (username, password) => ipcRenderer.invoke('auth-login', username, password),
    checkSetup: () => ipcRenderer.invoke('auth-checkSetup'),
    createAdmin: (username, password, fullName) => ipcRenderer.invoke('auth-createAdmin', username, password, fullName),
    getUsers: () => ipcRenderer.invoke('auth-getUsers'),
    createUser: (username, password, role, fullName, permissions) => ipcRenderer.invoke('auth-createUser', username, password, role, fullName, permissions),
    updateUser: (id, username, role, fullName, isActive, permissions) => ipcRenderer.invoke('auth-updateUser', id, username, role, fullName, isActive, permissions),
    resetPassword: (id, newPassword) => ipcRenderer.invoke('auth-resetPassword', id, newPassword),
    logout: () => ipcRenderer.invoke('auth-logout'),
    me: () => ipcRenderer.invoke('auth-me'),
    deleteUser: (id) => ipcRenderer.invoke('auth-deleteUser', id),
    getPermissionSchema: () => ipcRenderer.invoke('auth-getPermissionSchema'),
  },

  navigate: (page) => ipcRenderer.invoke('navigate', page),

  // Operations that own their table, so an extra permission is required.
  ops: {
    settleDebt: (party, payments, drawerBreakdown) => ipcRenderer.invoke('debt-settle', party, payments, drawerBreakdown),
    addDebtEntry: (customerId, amount, description) => ipcRenderer.invoke('debt-add-entry', customerId, amount, description),
    openShift: (startTime) => ipcRenderer.invoke('shift-open', startTime),
    closeShift: (id, summary) => ipcRenderer.invoke('shift-close', id, summary),
    cancelInvoice: (id) => ipcRenderer.invoke('invoice-cancel', id),
    saveExpense: (payload) => ipcRenderer.invoke('expense-save', payload),
    deleteExpense: (id) => ipcRenderer.invoke('expense-delete', id),
  },

  users: {
    nameMap: () => ipcRenderer.invoke('users-nameMap'),
  },

  telegram: {
    sendNotification: (type, data) => ipcRenderer.invoke('telegram-send', type, data),
  },

  cash: {
    getBalance: () => ipcRenderer.invoke('cash-getBalance'),
    // userId is intentionally NOT accepted - it comes from the main-process session.
    addDrawerEntry: (drawerType, amount, reason, referenceId) => ipcRenderer.invoke('cash-addDrawerEntry', drawerType, amount, reason, referenceId),
    addTreasuryEntry: (amount, reason, referenceId) => ipcRenderer.invoke('cash-addTreasuryEntry', amount, reason, referenceId),
    deleteEntry: (table, id) => ipcRenderer.invoke('cash-deleteEntry', table, id),
    deleteByReference: (referenceId) => ipcRenderer.invoke('cash-deleteByReference', referenceId),
  },

  print: {
    invoice: (data) => ipcRenderer.invoke('print-invoice', data),
  },

  backup: {
    create: () => ipcRenderer.invoke('backup-create'),
    restore: (filePath) => ipcRenderer.invoke('backup-restore', filePath),
    list: () => ipcRenderer.invoke('backup-list'),
    selectFile: () => ipcRenderer.invoke('backup-select-file'),
  },

  currency: {
    getDefault: () => ipcRenderer.invoke('currency-getDefault'),
    getAll: () => ipcRenderer.invoke('currency-getAll'),
    setDefault: (id) => ipcRenderer.invoke('currency-setDefault', id),
    add: (code, name, symbol, rate) => ipcRenderer.invoke('currency-add', code, name, symbol, rate),
    delete: (id) => ipcRenderer.invoke('currency-delete', id),
  }
});
