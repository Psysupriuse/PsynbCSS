// ============================================================
// Psy剪贴板 — 安全桥接
// 渲染进程只能通过 window.psy 访问主进程(contextIsolation 开启)
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('psy', {
  // 列表(阶段 2/3/4 接入)
  getItems: () => ipcRenderer.invoke('get-items'),
  getImage: (id) => ipcRenderer.invoke('get-image', id),
  pasteItem: (id) => ipcRenderer.invoke('paste-item', id),
  pinItem: (id, pinned) => ipcRenderer.invoke('pin-item', id, pinned),
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id),
  clearAll: () => ipcRenderer.invoke('clear-all'),
  // 窗口
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  // 设置(阶段 6 接入)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  suspendHotkey: (suspend) => ipcRenderer.invoke('suspend-hotkey', suspend),
  // 事件订阅
  onItemsChanged: (cb) => ipcRenderer.on('items-changed', (e, items) => cb(items)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (e, s) => cb(s)),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  onPanelShown: (cb) => ipcRenderer.on('panel-shown', () => cb())
});
