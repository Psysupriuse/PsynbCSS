// ============================================================
// Psy剪贴板 — 主进程
// 阶段规划见 docs/04-开发步骤与验收标准.md
// 当前进度:阶段 4(自动粘贴)+ 阶段 5(清理)+ 阶段 6(设置)
// ============================================================
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, clipboard, ClipboardItem } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- 运行模式 ----------
// SCREENSHOT:截图验证(注入示例数据,截图+界面检查报告后退出)
// SELFTEST:  数据层自检(自动跑一组断言后退出)
// UITEST:    UI 交互自检(模拟按键/点击跑端到端断言后退出)
// 这些模式的数据都写入 .devdata,不影响真实数据
const SCREENSHOT_MODE = !!process.env.PSY_SCREENSHOT;
const SELFTEST_MODE = !!process.env.PSY_SELFTEST;
const UITEST_MODE = !!process.env.PSY_UITEST;
if (SCREENSHOT_MODE || SELFTEST_MODE || UITEST_MODE) {
  app.setPath('userData', path.join(__dirname, '.devdata'));
}

// ---------- 常量 ----------
const MAX_ITEMS = 500;
const POLL_INTERVAL = 700;
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const TEXT_MAX_LENGTH = 100000;
const PASTE_DELAY = 300; // 隐藏窗口后等待焦点回到前一应用,再模拟 Ctrl+V

const DEFAULTS = {
  retentionDays: 3,
  hotkey: 'Control+Alt+V',
  filterPasswords: true,
  pasteOnClick: true,
  autoStart: true
};

// ---------- 状态 ----------
let mainWindow = null;
let tray = null;
let isQuitting = false;
let history = [];
let settings = { ...DEFAULTS };
let lastClipboardHash = null;
let pollTimer = null;
// UI 测试钩子:统计模拟 Ctrl+V 的调用次数(测试模式下不真正发送按键)
const pasteHooks = { invoked: 0 };

// ---------- 数据路径 ----------
const dataDir = app.getPath('userData');
const imagesDir = path.join(dataDir, 'images');
const historyPath = path.join(dataDir, 'history.json');
const settingsPath = path.join(dataDir, 'settings.json');

// ============================================================
// 数据存储
// ============================================================
function ensureDirs() {
  fs.mkdirSync(imagesDir, { recursive: true });
}

function loadHistory() {
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
}

function saveHistory() {
  try {
    fs.writeFileSync(historyPath, JSON.stringify(history));
  } catch (err) {
    console.error('[store] 保存历史失败:', err.message);
  }
}

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
  } catch (err) {
    console.error('[store] 保存设置失败:', err.message);
  }
}

function imageFileOf(item) {
  return path.join(imagesDir, item.id + '.png');
}

function deleteImageFile(item) {
  try { fs.unlinkSync(imageFileOf(item)); } catch {}
}

// 清理未被任何条目引用的孤儿图片文件(防止 history.json 丢失/损坏时磁盘泄漏)
function sweepOrphanImages() {
  try {
    const valid = new Set(history.filter((i) => i.type === 'image').map((i) => i.id + '.png'));
    for (const f of fs.readdirSync(imagesDir)) {
      if (!valid.has(f)) fs.unlinkSync(path.join(imagesDir, f));
    }
  } catch {}
}

// ============================================================
// 剪贴板记录
// ============================================================
function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// 疑似密码/验证码的保守匹配规则(可开关)
const PASSWORD_PATTERNS = [
  /(password|passwd|pwd|密码|口令|secret|token|api[_-]?key|access[_-]?key|私钥)\s*[:=:]\s*\S+/i,
  /(验证码|校验码|verification\s*code|auth\s*code)\s*(是|为|[:=:])\s*\S+/i
];

function looksSensitive(text) {
  return PASSWORD_PATTERNS.some((re) => re.test(text));
}

// 注意:Electron 44 起剪贴板 API 改为异步(详见 docs/02 §5.1)
async function readClipboardContent() {
  const items = await clipboard.read();
  for (const item of items) {
    const imgType = item.types.find((x) => x.startsWith('image/'));
    if (!imgType) continue;
    const blob = await item.getType(imgType);
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length === 0) continue;
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) continue;
    return { type: 'image', image: img };
  }
  const text = await clipboard.readText();
  if (text && text.trim()) return { type: 'text', text };
  return null;
}

function contentHash(content) {
  // 图片按解码后的像素数据哈希:系统会重编码 PNG,字节级哈希不稳定
  return content.type === 'image'
    ? 'i:' + md5(content.image.toBitmap())
    : 't:' + md5(content.text.trim());
}

function addClipboardContent(content) {
  let item;
  if (content.type === 'image') {
    item = { id: crypto.randomUUID(), type: 'image', pinned: false, createdAt: Date.now() };
    try {
      fs.writeFileSync(imageFileOf(item), content.image.toPNG());
    } catch (err) {
      console.error('[store] 图片保存失败:', err.message);
      return;
    }
  } else {
    const text = content.text.trim().slice(0, TEXT_MAX_LENGTH);
    if (!text) return;
    if (settings.filterPasswords && looksSensitive(text)) return;
    item = { id: crypto.randomUUID(), type: 'text', text, pinned: false, createdAt: Date.now() };
  }
  history.unshift(item);
  enforceCapacity();
  saveHistory();
  notifyItemsChanged();
}

// 容量上限:最多 MAX_ITEMS 条,超出删除最旧的非置顶条目(置顶豁免)
function enforceCapacity() {
  let count = 0;
  const kept = [];
  const removed = [];
  for (const item of history) {
    if (item.pinned || count < MAX_ITEMS) { kept.push(item); count++; }
    else removed.push(item);
  }
  if (removed.length) {
    history = kept;
    removed.forEach((i) => { if (i.type === 'image') deleteImageFile(i); });
  }
}

let polling = false;
async function pollClipboard() {
  if (polling) return; // 防止异步读取叠加
  polling = true;
  try {
    const content = await readClipboardContent();
    if (!content) return;
    const hash = contentHash(content);
    if (hash === lastClipboardHash) return;
    lastClipboardHash = hash;
    addClipboardContent(content);
  } catch (err) {
    console.error('[poll] 读取剪贴板失败:', err.message);
  } finally {
    polling = false;
  }
}

// 启动时记录当前剪贴板为基线,只记录"新复制"的内容
async function initClipboardBaseline() {
  try {
    const content = await readClipboardContent();
    if (content) lastClipboardHash = contentHash(content);
  } catch {}
}

// ============================================================
// 自动粘贴(阶段 4)
// ============================================================
function buildPasteScript() {
  return '$ws = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $ws.SendKeys("^v")';
}

function sendCtrlV() {
  if (UITEST_MODE) { pasteHooks.invoked++; return; } // 测试模式:只计数,不向系统发按键
  execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', buildPasteScript()], (err) => {
    if (err) console.error('[paste] 模拟 Ctrl+V 失败:', err.message);
  });
}

async function writeItemToClipboard(item) {
  if (item.type === 'text') {
    await clipboard.writeText(item.text);
    lastClipboardHash = 't:' + md5(item.text.trim());
    return true;
  }
  const file = imageFileOf(item);
  if (!fs.existsSync(file)) return false;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return false;
  await clipboard.write([new ClipboardItem({ 'image/png': img.toPNG() })]);
  lastClipboardHash = 'i:' + md5(img.toBitmap());
  return true;
}

// ============================================================
// 到期清理(阶段 5)
// ============================================================
function cleanupExpired() {
  const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  const kept = [];
  const removed = [];
  for (const item of history) {
    if (item.pinned || item.createdAt >= cutoff) kept.push(item);
    else removed.push(item);
  }
  if (removed.length) {
    history = kept;
    removed.forEach((i) => { if (i.type === 'image') deleteImageFile(i); });
    saveHistory();
    notifyItemsChanged();
  }
}

// ============================================================
// 窗口
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 320,
    minHeight: 420,
    frame: false,                       // 无边框,自绘标题栏(renderer)
    show: SCREENSHOT_MODE || UITEST_MODE,
    resizable: true,
    skipTaskbar: true,                  // 托盘应用,不出现在任务栏
    alwaysOnTop: true,
    backgroundColor: '#f2f8fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 失焦约 500ms 后自动隐藏(打开开发者工具时不隐藏)
  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()
          && !mainWindow.webContents.isDevToolsOpened()) hideWindow();
    }, 500);
  });

  // 关闭按钮 = 隐藏到托盘,不退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); hideWindow(); }
  });

  if (SCREENSHOT_MODE) setupScreenshotMode();
  if (UITEST_MODE) setupUITestMode();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  const [w, h] = mainWindow.getSize();
  let x = Math.round(cursor.x - w / 2);
  let y = Math.round(cursor.y + 12);
  if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
  if (x < wa.x) x = wa.x;
  if (y + h > wa.y + wa.height) y = Math.max(wa.y, cursor.y - h - 12);
  mainWindow.setPosition(x, y);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('panel-shown');
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) hideWindow(); else showWindow();
}

// ============================================================
// 托盘
// ============================================================
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Psy剪贴板');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示面板', click: showWindow },
    { label: '设置', click: () => { showWindow(); if (mainWindow) mainWindow.webContents.send('open-settings'); } },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!settings.autoStart,
      click: (mi) => {
        settings.autoStart = mi.checked;
        saveSettings();
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: mi.checked });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
}

// ============================================================
// 全局快捷键
// ============================================================
function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return;
  try {
    const ok = globalShortcut.register(settings.hotkey, toggleWindow);
    if (!ok) console.error('[hotkey] 注册失败(可能被其他程序占用):', settings.hotkey);
  } catch (err) {
    console.error('[hotkey] 快捷键无效:', settings.hotkey, err.message);
  }
}

// ============================================================
// IPC
// ============================================================
function notifyItemsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('items-changed', history);
}

ipcMain.handle('hide-window', () => { hideWindow(); });

ipcMain.handle('get-items', () => history);

// 图片缩略图(压缩后返回 data URL;原图保留用于回贴)
ipcMain.handle('get-image', (e, id) => {
  if (!/^[0-9a-f-]+$/i.test(id)) return null;
  const item = history.find((i) => i.id === id && i.type === 'image');
  if (!item) return null;
  const file = imageFileOf(item);
  if (!fs.existsSync(file)) return null;
  const img = nativeImage.createFromPath(file);
  const size = img.getSize();
  const out = size.height > 240 ? img.resize({ height: 240 }) : img;
  return 'data:image/png;base64,' + out.toPNG().toString('base64');
});

// 点击卡片回贴(阶段 4)
ipcMain.handle('paste-item', async (e, id) => {
  const item = history.find((i) => i.id === id);
  if (!item) return false;
  const ok = await writeItemToClipboard(item);
  if (!ok) return false;
  hideWindow();
  if (settings.pasteOnClick) setTimeout(sendCtrlV, PASTE_DELAY);
  return true;
});

ipcMain.handle('pin-item', (e, id, pinned) => {
  const item = history.find((i) => i.id === id);
  if (!item) return;
  item.pinned = !!pinned;
  item.pinnedAt = pinned ? Date.now() : undefined;
  saveHistory();
  notifyItemsChanged();
});

ipcMain.handle('delete-item', (e, id) => {
  const idx = history.findIndex((i) => i.id === id);
  if (idx === -1) return;
  const [item] = history.splice(idx, 1);
  if (item.type === 'image') deleteImageFile(item);
  saveHistory();
  notifyItemsChanged();
});

ipcMain.handle('clear-all', () => {
  const images = history.filter((i) => i.type === 'image');
  history = [];
  images.forEach(deleteImageFile);
  saveHistory();
  notifyItemsChanged();
});

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('set-settings', (e, patch) => {
  const oldHotkey = settings.hotkey;
  const oldRetention = settings.retentionDays;
  settings = { ...settings, ...patch };
  if (typeof settings.retentionDays !== 'number' || settings.retentionDays < 1) {
    settings.retentionDays = DEFAULTS.retentionDays;
  }
  if (typeof settings.hotkey !== 'string' || !settings.hotkey) settings.hotkey = oldHotkey;
  saveSettings();
  if (settings.hotkey !== oldHotkey) registerHotkey();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
  if (settings.retentionDays !== oldRetention) cleanupExpired();
  return settings;
});

// 录制快捷键期间暂停全局热键,避免按到旧热键触发面板
ipcMain.handle('suspend-hotkey', (e, suspend) => {
  if (suspend) globalShortcut.unregisterAll();
  else registerHotkey();
});

// ============================================================
// 截图模式:示例数据 + 界面检查报告(写入 .devdata)
// ============================================================
function seedDemoData() {
  ensureDirs();
  history = [];
  const mkText = (text, minutesAgo, pinned) => ({
    id: crypto.randomUUID(),
    type: 'text',
    text,
    pinned: !!pinned,
    pinnedAt: pinned ? Date.now() - minutesAgo * 60000 : undefined,
    createdAt: Date.now() - minutesAgo * 60000
  });
  history.push(
    mkText('会议纪要:\n1. 周五前完成设计评审\n2. 下周一定稿 UI 规范\n3. 和前端对齐接口时间', 2, false),
    mkText('这是置顶的重要内容,会一直保留在最上方', 60 * 24 * 2, true),
    mkText('https://example.com/some/very/long/url/that/should/be/truncated/in/the/card/preview', 45, false),
    mkText('很久以前复制的一段话,应该显示完整日期时间', 60 * 24 * 45, false)
  );
  // 一张渐变示例图片
  const imgItem = { id: crypto.randomUUID(), type: 'image', pinned: false, createdAt: Date.now() - 30 * 60000 };
  fs.writeFileSync(imageFileOf(imgItem), makeTestImage().toPNG());
  history.push(imgItem);
  saveHistory();
}

function makeTestImage() {
  const w = 320, h = 180;
  const bitmap = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      bitmap[i] = Math.round(91 + (220 - 91) * x / w);      // B
      bitmap[i + 1] = Math.round(168 + (240 - 168) * x / w); // G
      bitmap[i + 2] = Math.round(224 + (250 - 224) * x / w); // R
      bitmap[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: w, height: h });
}

function setupScreenshotMode() {
  const rendererLogs = [];
  mainWindow.webContents.on('console-message', (event, a, b) => {
    const details = (typeof a === 'object' && a !== null) ? a : { level: a, message: b };
    rendererLogs.push((details.level === 3 ? '[error] ' : details.level === 2 ? '[warn] ' : '') + details.message);
    if (details.level >= 2) console.log('[renderer]', details.message);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const report = await mainWindow.webContents.executeJavaScript(`(() => {
          const gs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
          return {
            title: document.title,
            titlebarBg: gs('#titlebar', 'backgroundImage'),
            bodyBg: getComputedStyle(document.body).backgroundColor,
            viewport: [window.innerWidth, window.innerHeight],
            cardCount: document.querySelectorAll('.card').length,
            firstCardPinned: document.querySelector('.card')?.classList.contains('pinned') ?? false,
            pinnedBadgeCount: document.querySelectorAll('.pin-badge').length,
            timeLabels: [...document.querySelectorAll('.card-time')].map((el) => el.textContent),
            imageLoaded: [...document.querySelectorAll('img.thumb')].some((el) => el.src.startsWith('data:')),
            emptyStateVisible: !document.querySelector('#empty-state').hidden,
            settingsViewHidden: document.querySelector('#view-settings').hidden
          };
        })()`);
        report.rendererLogs = rendererLogs;
        fs.writeFileSync(path.join(__dirname, 'shot-report.json'), JSON.stringify(report, null, 2));
        console.log('[shot] 界面检查:', JSON.stringify(report, null, 2));
      } catch (err) {
        console.error('[shot] 界面检查失败:', err);
      }
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'shot.png'), image.toPNG());
        fs.writeFileSync(path.join(__dirname, 'shot.jpg'), image.toJPEG(85));
        console.log('[shot] 截图已保存: shot.png / shot.jpg(可直接打开查看)');
      } catch (err) {
        console.error('[shot] 截图失败:', err);
      }
      app.quit();
    }, 1500);
  });
}

// ============================================================
// 自检模式:阶段 2/4/5 数据层自动验证(写入 .devdata)
// ============================================================
async function runSelfTest() {
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail: detail ?? '' });
    console.log(`[test] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  try {
    ensureDirs();
    settings = { ...DEFAULTS }; // 固定配置,保证测试确定性
    history = [];
    if (fs.existsSync(imagesDir)) {
      fs.readdirSync(imagesDir).forEach((f) => fs.rmSync(path.join(imagesDir, f)));
    }

    // 1. 记录文字
    await clipboard.writeText('你好,这是第一条测试内容');
    await pollClipboard();
    check('记录文字', history.length === 1 && history[0].type === 'text' && history[0].text === '你好,这是第一条测试内容');

    // 2. 去重:连续复制相同内容只记一次
    await clipboard.writeText('你好,这是第一条测试内容');
    await pollClipboard();
    check('连续复制相同内容去重', history.length === 1, '条数=' + history.length);

    // 3. 密码类内容被过滤
    await clipboard.writeText('password: 123456');
    await pollClipboard();
    check('密码类内容被过滤', history.length === 1, '条数=' + history.length);

    // 4. 记录第二条文字
    await clipboard.writeText('第二条内容,用于验证列表顺序');
    await pollClipboard();
    check('记录第二条文字(时间倒序)', history.length === 2 && history[0].text === '第二条内容,用于验证列表顺序');

    // 5. 记录图片 + 图片文件落盘
    const w = 80, h = 60;
    const bitmap = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { bitmap[i * 4] = 91; bitmap[i * 4 + 1] = 168; bitmap[i * 4 + 2] = 224; bitmap[i * 4 + 3] = 255; }
    const testImg = nativeImage.createFromBitmap(bitmap, { width: w, height: h });
    await clipboard.write([new ClipboardItem({ 'image/png': testImg.toPNG() })]);
    await pollClipboard();
    check('记录图片并保存文件', history[0]?.type === 'image' && fs.existsSync(imageFileOf(history[0])), '文件=' + imageFileOf(history[0]));

    // 6. 持久化:模拟重启,从磁盘重新加载
    loadHistory();
    check('重启后数据仍在(持久化)', history.length === 3, '条数=' + history.length);

    // 7. 设置持久化
    settings = { ...DEFAULTS, retentionDays: 5 };
    saveSettings();
    loadSettings();
    check('设置持久化', settings.retentionDays === 5, 'retentionDays=' + settings.retentionDays);

    // 8. 容量上限:普通条目最多 500 条,置顶豁免(阶段 5)
    history = [];
    const pinnedIds = [];
    for (let i = 0; i < 5; i++) {
      addClipboardContent({ type: 'text', text: '置顶内容 ' + i });
      history[0].pinned = true;
      history[0].pinnedAt = Date.now();
      pinnedIds.push(history[0].id);
    }
    const oldestId = crypto.randomUUID();
    history.push({ id: oldestId, type: 'text', text: '最旧的普通条目', pinned: false, createdAt: 1 });
    for (let i = 0; i < 501; i++) addClipboardContent({ type: 'text', text: '普通内容 ' + i });
    check('容量上限(普通条目不超过 500 条)', history.filter((i) => !i.pinned).length === 500, '普通=' + history.filter((i) => !i.pinned).length + ',置顶=' + history.filter((i) => i.pinned).length);
    check('容量清理移除最旧的非置顶条目', !history.some((i) => i.id === oldestId));
    check('置顶条目豁免容量清理', pinnedIds.every((id) => history.some((i) => i.id === id && i.pinned)));

    // 9. 到期清理:置顶豁免 + 图片文件同步删除(阶段 5)
    history = [];
    const day = 24 * 60 * 60 * 1000;
    const oldText = { id: crypto.randomUUID(), type: 'text', text: '过期文字', pinned: false, createdAt: Date.now() - 10 * day };
    const freshText = { id: crypto.randomUUID(), type: 'text', text: '新鲜文字', pinned: false, createdAt: Date.now() - 2 * day };
    const oldPinned = { id: crypto.randomUUID(), type: 'text', text: '过期置顶', pinned: true, pinnedAt: Date.now() - 9 * day, createdAt: Date.now() - 10 * day };
    const oldImg = { id: crypto.randomUUID(), type: 'image', pinned: false, createdAt: Date.now() - 10 * day };
    fs.writeFileSync(imageFileOf(oldImg), testImg.toPNG());
    history = [oldText, freshText, oldPinned, oldImg];
    saveHistory();
    settings.retentionDays = 3;
    cleanupExpired();
    check('到期清理:过期未置顶条目被删除', history.length === 2 && history.some((i) => i.id === freshText.id) && history.some((i) => i.id === oldPinned.id), '条数=' + history.length);
    check('到期清理:置顶条目豁免', history.some((i) => i.id === oldPinned.id));
    check('到期清理:图片文件同步删除', !fs.existsSync(imageFileOf(oldImg)));
    history = [];
    saveHistory();

    // 10. 自动粘贴脚本生成(阶段 4,单元级)
    const script = buildPasteScript();
    check('粘贴脚本包含 Ctrl+V 模拟', script.includes('SendKeys') && script.includes('^v'));

    // 收尾:清理测试数据,保持 .devdata 干净
    history = [];
    saveHistory();
    if (fs.existsSync(imagesDir)) {
      fs.readdirSync(imagesDir).forEach((f) => fs.rmSync(path.join(imagesDir, f)));
    }
  } catch (err) {
    check('自检过程无异常', false, err.message);
    console.error('[test] 异常:', err);
  }

  const passed = results.filter((r) => r.pass).length;
  fs.writeFileSync(path.join(__dirname, 'selftest-report.json'), JSON.stringify(results, null, 2));
  console.log(`[test] 结果: ${passed}/${results.length} 通过`);
  app.exit(passed === results.length ? 0 : 1);
}

// ============================================================
// UI 交互测试模式:阶段 3/4/6 端到端验证(写入 .devdata)
// ============================================================
async function runUITests() {
  const wc = mainWindow.webContents;
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail: detail ?? '' });
    console.log(`[uitest] ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaljs = (code) => wc.executeJavaScript(code);
  const key = (type, keyCode, modifiers) => wc.sendInputEvent({ type, keyCode, modifiers });

  try {
    showWindow(); // 定位到鼠标处并聚焦
    await sleep(1000);

    // T1 初始渲染(阶段 3)
    check('初始渲染 5 张卡片且置顶卡在最上', await evaljs(`document.querySelectorAll('.card').length`) === 5
      && await evaljs(`document.querySelector('.card')?.classList.contains('pinned')`) === true);
    check('默认快捷键已注册', globalShortcut.isRegistered(settings.hotkey), 'hotkey=' + settings.hotkey);

    // T2 搜索:真实按键输入(阶段 3)——定位用户反馈的"搜索不能输入"问题
    await evaljs(`(() => { const si = document.querySelector('#search-input'); si.focus(); si.value = ''; si.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    for (const c of ['u', 'r', 'l']) { key('char', c); await sleep(80); }
    const typedValue = await evaljs(`document.querySelector('#search-input').value`);
    check('搜索框真实按键输入生效', typedValue === 'url', '输入框内容=' + JSON.stringify(typedValue));
    check('输入后列表实时过滤', await evaljs(`document.querySelectorAll('.card').length`) === 1
      && await evaljs(`document.querySelector('.card .text-content')?.textContent.includes('example.com')`));

    // T3 搜索:中文内容过滤(直接赋值 + input 事件)
    await evaljs(`(() => { const si = document.querySelector('#search-input'); si.value = '会议'; si.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    check('中文关键词过滤', await evaljs(`document.querySelectorAll('.card').length`) === 1
      && await evaljs(`document.querySelector('.card .text-content')?.textContent.includes('会议纪要')`));

    // T4 清空搜索恢复完整列表
    await evaljs(`(() => { const si = document.querySelector('#search-input'); si.value = ''; si.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    check('清空搜索恢复 5 张卡片', await evaljs(`document.querySelectorAll('.card').length`) === 5);

    // T5 置顶/取消置顶(阶段 3)
    await evaljs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.text-content')?.textContent.includes('会议纪要'));
      if (!card) return 'card-not-found';
      card.querySelector('.act-btn').click();
      return 'clicked';
    })()`);
    await sleep(400);
    check('置顶后徽标数量+1 且置顶卡在最上', await evaljs(`document.querySelectorAll('.pin-badge').length`) === 2
      && await evaljs(`document.querySelector('.card')?.classList.contains('pinned')`));
    await evaljs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.text-content')?.textContent.includes('会议纪要'));
      card.querySelector('.act-btn').click();
      return true;
    })()`);
    await sleep(400);
    check('取消置顶恢复', await evaljs(`document.querySelectorAll('.pin-badge').length`) === 1);

    // T6 删除(阶段 3)
    await evaljs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.text-content')?.textContent.includes('很久以前'));
      if (!card) return 'card-not-found';
      card.querySelector('.act-btn.danger').click();
      return 'clicked';
    })()`);
    await sleep(400);
    check('删除卡片后剩 4 张', history.length === 4 && await evaljs(`document.querySelectorAll('.card').length`) === 4);

    // T7 点击文字卡回贴(阶段 4)
    await evaljs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.text-content')?.textContent.includes('会议纪要'));
      card.click();
      return true;
    })()`);
    await sleep(700);
    check('点击文字卡:剪贴板内容正确', (await clipboard.readText()).includes('会议纪要'));
    check('点击文字卡:窗口自动隐藏', !mainWindow.isVisible());
    check('点击文字卡:模拟粘贴被触发', pasteHooks.invoked === 1, 'invoked=' + pasteHooks.invoked);
    check('回贴不产生新记录', history.length === 4, '条数=' + history.length);
    await pollClipboard(); // 相当于下一次轮询
    check('回贴内容不会被轮询重复记录', history.length === 4, '条数=' + history.length);

    // T8 点击图片卡回贴(阶段 4)
    showWindow();
    await sleep(500);
    await evaljs(`(() => { document.querySelector('.image-content')?.closest('.card')?.click(); return true; })()`);
    await sleep(700);
    const imgItems = await clipboard.read();
    check('点击图片卡:剪贴板为图片', imgItems.some((it) => it.types.some((t) => t.startsWith('image/'))));
    check('点击图片卡:窗口自动隐藏', !mainWindow.isVisible());
    check('点击图片卡:模拟粘贴被触发', pasteHooks.invoked === 2, 'invoked=' + pasteHooks.invoked);

    // T9 "仅复制"模式:只写剪贴板,不模拟粘贴(阶段 4 行为,开关 UI 属阶段 6)
    settings.pasteOnClick = false;
    saveSettings();
    showWindow();
    await sleep(500);
    await evaljs(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.text-content')?.textContent.includes('example.com'));
      card.click();
      return true;
    })()`);
    await sleep(500);
    check('仅复制模式:剪贴板已更新', (await clipboard.readText()).includes('example.com'));
    check('仅复制模式:不触发模拟粘贴', pasteHooks.invoked === 2, 'invoked=' + pasteHooks.invoked);
    check('仅复制模式:窗口仍隐藏', !mainWindow.isVisible());
    settings.pasteOnClick = true;
    saveSettings();

    // T10 设置视图 + 保存期限(阶段 6)
    showWindow();
    await sleep(500);
    await evaljs(`document.querySelector('#btn-settings').click()`);
    await sleep(400);
    check('设置视图已打开', await evaljs(`!document.querySelector('#view-settings').hidden && document.querySelector('#view-list').hidden`));
    await evaljs(`document.querySelector('input[name="retention"][value="5"]').click()`);
    await sleep(400);
    check('选择"5 天"生效并持久化', settings.retentionDays === 5
      && JSON.parse(fs.readFileSync(settingsPath, 'utf8')).retentionDays === 5);

    // T11 自定义保存期限(阶段 6)
    await evaljs(`document.querySelector('input[name="retention"][value="custom"]').click()`);
    await sleep(200);
    await evaljs(`(() => {
      const input = document.querySelector('#retention-custom');
      input.value = '7';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    check('自定义"7 天"生效', settings.retentionDays === 7);
    await evaljs(`document.querySelector('input[name="retention"][value="3"]').click()`);
    await sleep(400);
    check('恢复"3 天"生效', settings.retentionDays === 3);

    // T12 快捷键录制(阶段 6)
    const defaultHotkey = settings.hotkey;
    await evaljs(`document.querySelector('#hotkey-btn').click()`);
    await sleep(300);
    key('keyDown', 'F9', ['control', 'alt']);
    key('keyUp', 'F9', ['control', 'alt']);
    await sleep(500);
    check('录制新快捷键 Control+Alt+F9 生效', settings.hotkey === 'Control+Alt+F9'
      && globalShortcut.isRegistered('Control+Alt+F9'));
    settings.hotkey = defaultHotkey;
    saveSettings();
    registerHotkey();
    check('恢复默认快捷键', globalShortcut.isRegistered(defaultHotkey));

    // T13 开关持久化(阶段 6)
    await evaljs(`(() => {
      const el = document.querySelector('#toggle-filter');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    check('关闭智能过滤生效并持久化', settings.filterPasswords === false
      && JSON.parse(fs.readFileSync(settingsPath, 'utf8')).filterPasswords === false);
    await evaljs(`(() => {
      const el = document.querySelector('#toggle-filter');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    check('重新开启智能过滤', settings.filterPasswords === true);

    // T14 清空全部历史(阶段 6)
    await evaljs(`(() => { window.confirm = () => true; document.querySelector('#btn-clear').click(); return true; })()`);
    await sleep(500);
    check('清空全部历史', history.length === 0);
    check('清空后图片目录为空', fs.readdirSync(imagesDir).length === 0);
    check('清空后显示空状态', await evaljs(`!document.querySelector('#empty-state').hidden && document.querySelectorAll('.card').length === 0`));

    // T15 Esc 收起面板(阶段 1 行为回归)
    showWindow();
    await sleep(400);
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    await sleep(400);
    check('Esc 收起面板', !mainWindow.isVisible());
  } catch (err) {
    check('UI 测试过程无异常', false, err.message);
    console.error('[uitest] 异常:', err);
  }

  const passed = results.filter((r) => r.pass).length;
  fs.writeFileSync(path.join(__dirname, 'uitest-report.json'), JSON.stringify(results, null, 2));
  console.log(`[uitest] 结果: ${passed}/${results.length} 通过`);
  app.exit(passed === results.length ? 0 : 1);
}

function setupUITestMode() {
  mainWindow.webContents.on('console-message', (event, a, b) => {
    const details = (typeof a === 'object' && a !== null) ? a : { level: a, message: b };
    if (details.level >= 2) console.log('[renderer]', details.message);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { runUITests(); }, 800);
  });
}

// ============================================================
// 应用生命周期
// ============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 已有实例在运行
} else {
  app.on('second-instance', () => { if (mainWindow) showWindow(); });
  app.whenReady().then(async () => {
    ensureDirs();
    loadSettings();
    saveSettings(); // 首次启动物化默认配置,保证 settings.json 存在
    loadHistory();
    sweepOrphanImages();

    if (SELFTEST_MODE) {
      runSelfTest();
      return;
    }

    if (SCREENSHOT_MODE || UITEST_MODE) {
      settings = { ...DEFAULTS }; // 测试模式固定配置,保证确定性
      saveSettings();
      seedDemoData();
    }

    createWindow();

    if (!SCREENSHOT_MODE && !UITEST_MODE) createTray();
    if (!SCREENSHOT_MODE) {
      registerHotkey();
      // UI 测试:默认快捷键被其他程序占用时改用备用键,保证测试确定性
      if (UITEST_MODE && !globalShortcut.isRegistered(settings.hotkey)) {
        settings.hotkey = 'Control+Alt+F10';
        saveSettings();
        registerHotkey();
      }
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
    }
    if (!SCREENSHOT_MODE && !UITEST_MODE) {
      await initClipboardBaseline();
      pollTimer = setInterval(pollClipboard, POLL_INTERVAL);
      cleanupExpired();
      setInterval(cleanupExpired, CLEANUP_INTERVAL);
    }
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (pollTimer) clearInterval(pollTimer);
  });
}
