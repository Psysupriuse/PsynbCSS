// ============================================================
// Psy剪贴板 — 渲染进程
// 当前进度:阶段 4(点击回贴)+ 阶段 6(设置界面)
// ============================================================
const $ = (sel) => document.querySelector(sel);

let items = [];
let query = '';
let settingsState = null;
let recordingHotkey = false;
const imageCache = new Map();
let imageObserver = null;

// ---------- 工具 ----------
function formatTime(ts) {
  const diff = Date.now() - ts;
  const m = 60000, h = 3600000, d = 86400000;
  if (diff < m) return '刚刚';
  if (diff < h) return Math.floor(diff / m) + ' 分钟前';
  if (diff < d) return Math.floor(diff / h) + ' 小时前';
  if (diff < 30 * d) return Math.floor(diff / d) + ' 天前';
  const dt = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
}

// 置顶组在上(按置顶时间倒序),普通组按复制时间倒序
function sortedItems() {
  const pinned = items.filter((i) => i.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  return [...pinned, ...items.filter((i) => !i.pinned)];
}

// 搜索非空时仅显示匹配的文字条目(图片无文字可搜)
function visibleItems() {
  const q = query.trim().toLowerCase();
  const sorted = sortedItems();
  if (!q) return sorted;
  return sorted.filter((i) => i.type === 'text' && i.text.toLowerCase().includes(q));
}

// ---------- 列表渲染 ----------
function render() {
  const list = $('#list');
  const scrollTop = list.scrollTop;
  list.innerHTML = '';
  const vis = visibleItems();
  $('#empty-state').hidden = vis.length > 0;
  for (const item of vis) list.appendChild(createCard(item));
  list.scrollTop = scrollTop;
  updateImageLoading();
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.pinned ? ' pinned' : '');
  card.dataset.id = item.id;
  card.title = new Date(item.createdAt).toLocaleString();

  const content = document.createElement('div');
  if (item.type === 'text') {
    content.className = 'text-content';
    content.textContent = item.text;
  } else {
    content.className = 'image-content';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '图片';
    content.appendChild(img);
  }
  card.appendChild(content);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatTime(item.createdAt);
  meta.appendChild(time);
  if (item.pinned) {
    const badge = document.createElement('span');
    badge.className = 'pin-badge';
    badge.textContent = '📌 置顶';
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const pinBtn = document.createElement('button');
  pinBtn.className = 'act-btn';
  pinBtn.textContent = item.pinned ? '取消置顶' : '置顶';
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.psy.pinItem(item.id, !item.pinned);
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'act-btn danger';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.psy.deleteItem(item.id);
  });
  actions.append(pinBtn, delBtn);
  card.appendChild(actions);

  // 点击卡片 = 回贴;正在选中文字时不触发(允许手动复制卡片内文字)
  card.addEventListener('click', () => {
    if (window.getSelection().toString()) return;
    window.psy.pasteItem(item.id);
  });
  return card;
}

// ---------- 图片缩略图懒加载 ----------
function updateImageLoading() {
  if (imageObserver) imageObserver.disconnect();
  imageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      imageObserver.unobserve(en.target);
      loadThumb(en.target);
    }
  }, { root: $('#list'), rootMargin: '100px' });
  document.querySelectorAll('img.thumb').forEach((img) => imageObserver.observe(img));
}

async function loadThumb(img) {
  const id = img.closest('.card').dataset.id;
  if (imageCache.has(id)) { img.src = imageCache.get(id); return; }
  try {
    const dataUrl = await window.psy.getImage(id);
    if (!dataUrl) return;
    imageCache.set(id, dataUrl);
    img.src = dataUrl;
  } catch (err) {
    console.error('[thumb] 加载失败:', id, err);
  }
}

// ---------- 视图切换与面板行为 ----------
function showView(name) {
  $('#view-list').hidden = name !== 'list';
  $('#view-settings').hidden = name !== 'settings';
}

$('#btn-hide').addEventListener('click', () => window.psy.hideWindow());
$('#btn-settings').addEventListener('click', () => { showView('settings'); loadSettingsIntoUI(); });
$('#btn-back').addEventListener('click', () => showView('list'));

// ---------- 搜索 ----------
$('#search-input').addEventListener('input', (e) => {
  query = e.target.value;
  render();
});

// ---------- 设置界面 ----------
async function loadSettingsIntoUI() {
  settingsState = await window.psy.getSettings();
  applySettingsUI();
}

async function saveSetting(patch) {
  settingsState = await window.psy.setSettings(patch);
  applySettingsUI();
}

function applySettingsUI() {
  const r = settingsState.retentionDays;
  const isPreset = [1, 3, 5].includes(r);
  const radio = isPreset
    ? document.querySelector(`input[name="retention"][value="${r}"]`)
    : document.querySelector('input[name="retention"][value="custom"]');
  if (radio) radio.checked = true;
  $('#retention-custom').value = isPreset ? '' : r;
  $('#hotkey-btn').textContent = settingsState.hotkey;
  $('#toggle-filter').checked = !!settingsState.filterPasswords;
  $('#toggle-paste').checked = !!settingsState.pasteOnClick;
  $('#toggle-autostart').checked = !!settingsState.autoStart;
}

// 保存期限
function applyRetentionRadio() {
  const sel = document.querySelector('input[name="retention"]:checked');
  if (!sel) return;
  if (sel.value === 'custom') {
    const v = parseInt($('#retention-custom').value, 10);
    if (!v || v < 1) return;
    saveSetting({ retentionDays: v });
  } else {
    saveSetting({ retentionDays: parseInt(sel.value, 10) });
  }
}

document.querySelectorAll('input[name="retention"]').forEach((radio) => {
  radio.addEventListener('change', applyRetentionRadio);
});
$('#retention-custom').addEventListener('change', () => {
  if (document.querySelector('input[name="retention"][value="custom"]').checked) applyRetentionRadio();
});

// 快捷键录制
function normalizeKey(key) {
  if (key.length === 1) return key.toUpperCase();
  if (key === ' ') return 'Space';
  const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
  return map[key] || key;
}

async function cancelHotkeyRecording() {
  recordingHotkey = false;
  $('#hotkey-btn').classList.remove('recording');
  $('#hotkey-btn').textContent = settingsState.hotkey;
  $('#hotkey-hint').textContent = '';
  await window.psy.suspendHotkey(false);
}

$('#hotkey-btn').addEventListener('click', async () => {
  if (recordingHotkey) return;
  recordingHotkey = true;
  $('#hotkey-btn').textContent = '请按下新快捷键…';
  $('#hotkey-btn').classList.add('recording');
  $('#hotkey-hint').textContent = '按 Esc 取消';
  await window.psy.suspendHotkey(true); // 录制期间暂停全局热键,避免触发面板
});

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    if (recordingHotkey) { e.preventDefault(); cancelHotkeyRecording(); }
    else window.psy.hideWindow();
    return;
  }
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (mods.length === 0) {
    $('#hotkey-hint').textContent = '快捷键需包含 Ctrl / Alt / Shift 中的至少一个';
    return;
  }
  const acc = [...mods, normalizeKey(e.key)].join('+');
  recordingHotkey = false;
  $('#hotkey-btn').classList.remove('recording');
  settingsState = await window.psy.setSettings({ hotkey: acc });
  applySettingsUI();
  $('#hotkey-hint').textContent = '已保存:' + acc;
  await window.psy.suspendHotkey(false);
});

// 开关项
$('#toggle-filter').addEventListener('change', (e) => saveSetting({ filterPasswords: e.target.checked }));
$('#toggle-paste').addEventListener('change', (e) => saveSetting({ pasteOnClick: e.target.checked }));
$('#toggle-autostart').addEventListener('change', (e) => saveSetting({ autoStart: e.target.checked }));

// 清空全部历史
$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('确定要清空全部历史记录吗?此操作不可恢复。')) return;
  await window.psy.clearAll();
  showView('list');
});

// ---------- 与主进程同步 ----------
window.psy.getItems().then((list) => {
  items = list || [];
  render();
});

window.psy.onItemsChanged((newItems) => {
  items = newItems || [];
  render();
});

window.psy.onOpenSettings(() => {
  showView('settings');
  loadSettingsIntoUI();
});

// 面板每次弹出:回到列表视图、清空搜索并聚焦搜索框
window.psy.onPanelShown(() => {
  showView('list');
  const si = $('#search-input');
  if (si.value) { si.value = ''; query = ''; render(); }
  si.focus();
});

// 每分钟刷新一次相对时间显示
setInterval(render, 60000);
