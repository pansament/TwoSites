// main.js
import { app, BrowserWindow, BrowserView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// ---- Runtime safety: reduce chances of "blank" windows on some GPUs/VMs
app.disableHardwareAcceleration();

// -------- Globals
let mainWindow;
let topView;
let bottomView;
let config;
let cfgPathInUse = null;
let defaultUA = { top: null, bottom: null };

// ---- Helpers

function getExeDir() {
  try {
    return path.dirname(app.getPath('exe'));
  } catch {
    return process.cwd();
  }
}

function findConfigPath() {
  const exeDir = getExeDir();
  const candidates = [
    path.join(exeDir, 'config.json'),        // portable / next to EXE (preferred)
    path.join(process.cwd(), 'config.json'), // dev fallback
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // If none exist, default to exeDir for future writes/expectations
  return path.join(exeDir, 'config.json');
}

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
  // Fallback defaults (you can inline your own baked defaults here if desired)
  return normalizeConfig({});
}

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

// Simple debounce for file watcher
function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Layout

function layout() {
  if (!mainWindow || !topView || !bottomView) return;
  const [w, h] = mainWindow.getContentSize();
  const split = Math.round(h * config.dividerRatio);
  topView.setBounds({ x: 0, y: 0, width: w, height: split });
  topView.setAutoResize({ width: true, height: true });
  bottomView.setBounds({ x: 0, y: split, width: w, height: h - split });
  bottomView.setAutoResize({ width: true, height: true });
}

// ---- Apply config changes live

function applyConfigChanges(next) {
  // Determine what changed
  const urlsChanged =
    next.topUrl !== config.topUrl || next.bottomUrl !== config.bottomUrl;
  const ratioChanged = next.dividerRatio !== config.dividerRatio;
  const uaChanged = next.userAgent !== config.userAgent;
  const lockChanged = next.lockToInitialOrigin !== config.lockToInitialOrigin;

  config = next;

  // Update user agent on each view if changed
  if (uaChanged && topView && bottomView) {
    try {
      if (config.userAgent) {
        topView.webContents.setUserAgent(config.userAgent);
        bottomView.webContents.setUserAgent(config.userAgent);
      } else {
        // Restore defaults if we captured them
        if (defaultUA.top) topView.webContents.setUserAgent(defaultUA.top);
        if (defaultUA.bottom) bottomView.webContents.setUserAgent(defaultUA.bottom);
      }
    } catch {}
  }

  // Re-guard navigation if lock setting changed
  if (lockChanged) {
    // Remove old handlers by recreating views is heavy; instead, rely on handler logic
    // Since we only ever *tighten* rules, we can add guards now if they weren't present
    guardNavigation(topView, config.topUrl);
    guardNavigation(bottomView, config.bottomUrl);
  }

  // Reload URLs if changed or UA changed (UA affects next navigation)
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

  // Re-apply layout if divider changed
  if (ratioChanged) layout();
}

function watchConfigFile() {
  if (!cfgPathInUse) return;
  try {
    const handler = debounce(() => {
      try {
        const next = loadConfig();
        applyConfigChanges(next);
      } catch {
        // Ignore transient parse errors while file is being saved
      }
    }, 300);

    // Prefer fs.watch; if it fails on network shares, fall back to watchFile
    const watcher = fs.watch(cfgPathInUse, { persistent: false }, handler);
    // On some filesystems, rename events may fire; also handle errors silently
    watcher.on('error', () => {
      try {
        fs.unwatchFile(cfgPathInUse);
      } catch {}
      try {
        fs.watchFile(cfgPathInUse, { interval: 500 }, handler);
      } catch {}
    });
  } catch {
    // Fallback: polling
    try {
      fs.watchFile(cfgPathInUse, { interval: 500 }, debounce(() => {
        const next = loadConfig();
        applyConfigChanges(next);
      }, 300));
    } catch {}
  }
}

// ---- Create window and views

function createWindow() {
  config = loadConfig();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    backgroundColor: '#111111',
    show: true,                 // show immediately
    autoHideMenuBar: true,      // no menu (no address bar)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Safety net: ensure it shows even if pages hang
  setTimeout(() => { try { mainWindow.show(); } catch {} }, 1500);

  // Create the two panes
  topView = new BrowserView({
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  bottomView = new BrowserView({
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  mainWindow.setBrowserView(topView);
  mainWindow.addBrowserView(bottomView);

  // Capture default UA strings before any overrides
  try {
    defaultUA.top = topView.webContents.getUserAgent?.() || null;
    defaultUA.bottom = bottomView.webContents.getUserAgent?.() || null;
  } catch {}

  // Optional custom UA
  if (config.userAgent) {
    try {
      topView.webContents.setUserAgent(config.userAgent);
      bottomView.webContents.setUserAgent(config.userAgent);
    } catch {}
  }

  // Load URLs
  const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;
  topView.webContents.loadURL(config.topUrl, loadOpts).catch(() => {});
  bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(() => {});

  // Navigation guard (optional, per config)
  guardNavigation(topView, config.topUrl);
  guardNavigation(bottomView, config.bottomUrl);

  // Layout now and on resize
  mainWindow.on('resize', layout);
  mainWindow.once('ready-to-show', () => { layout(); try { mainWindow.show(); } catch {} });

  // Useful diagnostics if something fails to load
  for (const wc of [topView.webContents, bottomView.webContents]) {
    wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
      console.error('did-fail-load', code, desc, validatedURL);
    });
    wc.on('crashed', () => console.error('webContents crashed'));
  }

  // Start watching config.json for live updates
  watchConfigFile();
}

// ---- App lifecycle

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
