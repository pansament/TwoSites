// main.js (ESM)
import { app, BrowserWindow, BrowserView, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Disable GPU to avoid blank windows on some enterprise GPUs/VMs
app.disableHardwareAcceleration();

let mainWindow; let topView; let bottomView; let config; let cfgPathInUse = null;
let defaultUA = { top: null, bottom: null };
let logFile = null;

// ---------- utils ----------
function getPortableDir() { return process.env.PORTABLE_EXECUTABLE_DIR || null; }
function getExeDir() { try { return path.dirname(app.getPath('exe')); } catch { return process.cwd(); } }
function getLogPath() { const base = getPortableDir() || getExeDir() || process.cwd(); return path.join(base, 'two-sites-viewer.log'); }
function log(...args) {
  try {
    const line = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    if (!logFile) logFile = getLogPath();
    fs.appendFileSync(logFile, line);
  } catch {}
  try { console.log(...args); } catch {}
}
function normalizeConfig(cfg) {
  return {
    topUrl: cfg?.topUrl || 'https://example.com',
    bottomUrl: cfg?.bottomUrl || 'https://example.com',
    dividerRatio: Math.min(0.9, Math.max(0.1, cfg?.dividerRatio ?? 0.55)),
    minWidth: cfg?.minWidth ?? 1000,
    minHeight: cfg?.minHeight ?? 700,
    userAgent: typeof cfg?.userAgent === 'string' ? cfg.userAgent.trim() : '',
    lockToInitialOrigin: !!cfg?.lockToInitialOrigin
  };
}
function candidatesForConfig() {
  const portableDir = getPortableDir();
  const exeDir = getExeDir();
  const cwd = process.cwd();
  const userData = app.getPath('userData');
  const resources = process.resourcesPath;
  const list = [];
  if (portableDir) list.push(path.join(portableDir, 'config.json'));
  list.push(
    path.join(exeDir, 'config.json'),
    path.join(cwd, 'config.json'),
    path.join(userData, 'config.json'),
    path.join(resources, 'config.json')
  );
  return list;
}
function ensureConfigExistsAt(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, JSON.stringify({
        topUrl: 'https://example.com',
        bottomUrl: 'https://example.com',
        dividerRatio: 0.55,
        minWidth: 1200,
        minHeight: 800,
        userAgent: '',
        lockToInitialOrigin: false
      }, null, 2));
      log('Created default config at', targetPath);
    }
  } catch (e) { log('Failed to create default config at', targetPath, e.message); }
}
function findConfigPath() {
  const candidates = candidatesForConfig();
  log('Config path candidates:');
  for (const p of candidates) { log('  -', p, fs.existsSync(p) ? '[exists]' : '[missing]'); }
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  const preferred = (getPortableDir() || getExeDir() || process.cwd());
  const fallback = path.join(preferred, 'config.json');
  ensureConfigExistsAt(fallback);
  return fallback;
}
function loadConfig() {
  const p = cfgPathInUse || findConfigPath();
  cfgPathInUse = p;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (e) {
    log('Failed to read/parse config at', p, e.message);
    return normalizeConfig({});
  }
}
function getOrigin(u) { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return ''; } }
function guardNavigation(view, initialUrl) {
  if (!config.lockToInitialOrigin) return;
  const origin = getOrigin(initialUrl);
  view.webContents.on('will-navigate', (e, url) => { if (getOrigin(url) !== origin) e.preventDefault(); });
  view.webContents.setWindowOpenHandler((d) => { return (getOrigin(d.url) !== origin) ? { action: 'deny' } : { action: 'allow' }; });
}
function layout() {
  if (!mainWindow || !topView || !bottomView) return;
  const [w, h] = mainWindow.getContentSize();
  const split = Math.round(h * config.dividerRatio);
  topView.setBounds({ x: 0, y: 0, width: w, height: split });
  topView.setAutoResize({ width: true, height: true });
  bottomView.setBounds({ x: 0, y: split, width: w, height: h - split });
  bottomView.setAutoResize({ width: true, height: true });
}
function applyConfigChanges(next) {
  const urlsChanged = next.topUrl !== config.topUrl || next.bottomUrl !== config.bottomUrl;
  const ratioChanged = next.dividerRatio !== config.dividerRatio;
  const uaChanged = next.userAgent !== config.userAgent;
  const lockChanged = next.lockToInitialOrigin !== config.lockToInitialOrigin;
  config = next;

  if (uaChanged && topView && bottomView) {
    try {
      if (config.userAgent) {
        topView.webContents.setUserAgent(config.userAgent);
        bottomView.webContents.setUserAgent(config.userAgent);
      } else {
        if (defaultUA.top) topView.webContents.setUserAgent(defaultUA.top);
        if (defaultUA.bottom) bottomView.webContents.setUserAgent(defaultUA.bottom);
      }
    } catch {}
  }
  if (lockChanged) { guardNavigation(topView, config.topUrl); guardNavigation(bottomView, config.bottomUrl); }
  if (urlsChanged || uaChanged) {
    const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;
    if (topView && topView.webContents.getURL() !== config.topUrl) topView.webContents.loadURL(config.topUrl, loadOpts).catch(() => {});
    else if (uaChanged && topView) topView.webContents.reload();
    if (bottomView && bottomView.webContents.getURL() !== config.bottomUrl) bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(() => {});
    else if (uaChanged && bottomView) bottomView.webContents.reload();
  }
  if (ratioChanged) layout();
}
function watchConfigFile() {
  if (!cfgPathInUse) return;
  const applyLater = debounce(() => {
    const next = loadConfig();
    log('Config change detected. Applying...');
    applyConfigChanges(next);
  }, 300);
  try {
    const w = fs.watch(cfgPathInUse, { persistent: false }, applyLater);
    w.on('error', () => {
      try { fs.unwatchFile(cfgPathInUse); } catch {}
      try { fs.watchFile(cfgPathInUse, { interval: 500 }, applyLater); } catch {}
    });
  } catch {
    try { fs.watchFile(cfgPathInUse, { interval: 500 }, applyLater); } catch {}
  }
}
function debounce(fn, ms = 250) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

function createWindow() {
  config = loadConfig();
  log('[TwoSites] Using config at:', cfgPathInUse);
  log('[TwoSites] Top URL:', config.topUrl);
  log('[TwoSites] Bottom URL:', config.bottomUrl);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    backgroundColor: '#111111',
    show: true,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });

  setTimeout(() => { try { mainWindow.show(); } catch {} }, 1500);

  topView = new BrowserView({ webPreferences: { contextIsolation: true, sandbox: true } });
  bottomView = new BrowserView({ webPreferences: { contextIsolation: true, sandbox: true } });
  mainWindow.setBrowserView(topView);
  mainWindow.addBrowserView(bottomView);

  try { defaultUA.top = topView.webContents.getUserAgent?.() || null; } catch {}
  try { defaultUA.bottom = bottomView.webContents.getUserAgent?.() || null; } catch {}
  if (config.userAgent) { try { topView.webContents.setUserAgent(config.userAgent); bottomView.webContents.setUserAgent(config.userAgent); } catch {} }

  const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;
  topView.webContents.loadURL(config.topUrl, loadOpts).catch(() => {});
  bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(() => {});
  guardNavigation(topView, config.topUrl);
  guardNavigation(bottomView, config.bottomUrl);

  mainWindow.on('resize', layout);
  mainWindow.once('ready-to-show', () => { layout(); try { mainWindow.show(); } catch {} });

  for (const wc of [topView.webContents, bottomView.webContents]) {
    wc.on('did-fail-load', (_e, code, desc, validatedURL) => { log('did-fail-load', code, desc, validatedURL); });
    wc.on('crashed', () => log('webContents crashed'));
  }

  watchConfigFile();

  if (!config.topUrl || config.topUrl.includes('example.com')) {
    setTimeout(() => {
      try {
        dialog.showMessageBox({
          type: 'warning',
          title: 'Two Sites Viewer',
          message: 'No valid config.json was found. A default config may have been created.',
          detail: `Config path used: ${cfgPathInUse}\n\nEdit this file and save; the app will auto-reload.`
        });
      } catch {}
    }, 800);
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
