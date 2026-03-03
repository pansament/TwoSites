// main.js (ESM)
import { app, BrowserWindow, BrowserView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Improve compatibility with some enterprise GPUs/VMs
app.disableHardwareAcceleration();

let mainWindow;
let topView;
let bottomView;
let config;
let cfgPathInUse = null;
let defaultUA = { top: null, bottom: null };

// ---------- Config loading ----------

function normalizeConfig(cfg) {
  return {
    topUrl: cfg?.topUrl || 'https://example.com',
    bottomUrl: cfg?.bottomUrl || 'https://example.com',
    dividerRatio: Math.min(0.9, Math.max(0.1, cfg?.dividerRatio ?? 0.55)),
    minWidth: cfg?.minWidth ?? 1000,
    minHeight: cfg?.minHeight ?? 700,
    userAgent: typeof cfg?.userAgent === 'string' ? cfg.userAgent.trim() : '',
    lockToInitialOrigin: !!cfg?.lockToInitialOrigin,
  };
}

function candidatesForConfig() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR; // electron-builder portable
  const exeDir = path.dirname(app.getPath('exe'));
  const cwd = process.cwd();
  const userData = app.getPath('userData');     // optional override location
  const resources = process.resourcesPath;      // baked default (if you ship one inside asar)

  const list = [];
  if (portableDir) list.push(path.join(portableDir, 'config.json'));
  list.push(
    path.join(exeDir, 'config.json'),
    path.join(cwd, 'config.json'),
    path.join(userData, 'config.json'),
    path.join(resources, 'config.json') // final fallback if bundled
  );
  return list;
}

function findConfigPath() {
  for (const p of candidatesForConfig()) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // If nothing exists, prefer PORTABLE_EXECUTABLE_DIR (if present) for future writes
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json');
  }
  return path.join(path.dirname(app.getPath('exe')), 'config.json');
}

function loadConfig() {
  const p = cfgPathInUse || findConfigPath();
  cfgPathInUse = p;
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      return normalizeConfig(parsed);
    }
  } catch {}
  // Fallback defaults — you can put your AWACS URLs here as a baked default if you want
  return normalizeConfig({});
}

// ---------- Navigation guard ----------

function getOrigin(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}`;
  } catch {
    return '';
  }
}

function guardNavigation(view, initialUrl) {
  if (!config.lockToInitialOrigin) return;
  const origin = getOrigin(initialUrl);

  view.webContents.on('will-navigate', (e, url) => {
    if (getOrigin(url) !== origin) e.preventDefault();
  });
  view.webContents.setWindowOpenHandler((d) => {
    if (getOrigin(d.url) !== origin) return { action: 'deny' };
    return { action: 'allow' };
  });
}

// ---------- Layout ----------

function layout() {
  if (!mainWindow || !topView || !bottomView) return;
  const [w, h] = mainWindow.getContentSize();
  const split = Math.round(h * config.dividerRatio);
  topView.setBounds({ x: 0, y: 0, width: w, height: split });
  topView.setAutoResize({ width: true, height: true });
  bottomView.setBounds({ x: 0, y: split, width: w, height: h - split });
  bottomView.setAutoResize({ width: true, height: true });
}

// ---------- Live apply changes ----------

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

  if (lockChanged) {
    // Re-apply guards (handlers are additive; we only tighten rules when enabled)
    guardNavigation(topView, config.topUrl);
    guardNavigation(bottomView, config.bottomUrl);
  }

  if (urlsChanged || uaChanged) {
    const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;
    if (topView && topView.webContents.getURL() !== config.topUrl) {
      topView.webContents.loadURL(config.topUrl, loadOpts).catch(() => {});
    } else if (uaChanged && topView) {
      topView.webContents.reload();
    }

    if (bottomView && bottomView.webContents.getURL() !== config.bottomUrl) {
      bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(() => {});
    } else if (uaChanged && bottomView) {
      bottomView.webContents.reload();
    }
  }

  if (ratioChanged) layout();
}

function watchConfigFile() {
  if (!cfgPathInUse) return;

  const tryApply = debounce(() => {
    try {
      const next = loadConfig();
      applyConfigChanges(next);
    } catch {
      // ignore transient parse errors while saving
    }
  }, 300);

  try {
    const watcher = fs.watch(cfgPathInUse, { persistent: false }, tryApply);
    watcher.on('error', () => {
      try { fs.unwatchFile(cfgPathInUse); } catch {}
      try { fs.watchFile(cfgPathInUse, { interval: 500 }, tryApply); } catch {}
    });
  } catch {
    try { fs.watchFile(cfgPathInUse, { interval: 500 }, tryApply); } catch {}
  }
}

function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Create window ----------

function createWindow() {
  config = loadConfig();
  console.log('[TwoSites] Using config at:', cfgPathInUse);
  console.log('[TwoSites] Top URL:', config.topUrl);
  console.log('[TwoSites] Bottom URL:', config.bottomUrl);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    backgroundColor: '#111111',
    show: true,            // show immediately
    autoHideMenuBar: true, // no address bar/menu
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Safety net: ensure it shows even if pages hang
  setTimeout(() => { try { mainWindow.show(); } catch {} }, 1500);

  topView = new BrowserView({ webPreferences: { contextIsolation: true, sandbox: true } });
  bottomView = new BrowserView({ webPreferences: { contextIsolation: true, sandbox: true } });

  mainWindow.setBrowserView(topView);
  mainWindow.addBrowserView(bottomView);

  // capture default UA
  try {
    defaultUA.top = topView.webContents.getUserAgent?.() || null;
    defaultUA.bottom = bottomView.webContents.getUserAgent?.() || null;
  } catch {}

  if (config.userAgent) {
    try {
      topView.webContents.setUserAgent(config.userAgent);
      bottomView.webContents.setUserAgent(config.userAgent);
    } catch {}
  }

  const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;
  topView.webContents.loadURL(config.topUrl, loadOpts).catch(() => {});
  bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(() => {});
  guardNavigation(topView, config.topUrl);
  guardNavigation(bottomView, config.bottomUrl);

  mainWindow.on('resize', layout);
  mainWindow.once('ready-to-show', () => { layout(); try { mainWindow.show(); } catch {} });

  // diagnostics
  for (const wc of [topView.webContents, bottomView.webContents]) {
    wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
      console.error('did-fail-load', code, desc, validatedURL);
    });
    wc.on('crashed', () => console.error('webContents crashed'));
  }

  watchConfigFile();
}

// ---------- App lifecycle ----------

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
