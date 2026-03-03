
import { app, BrowserWindow, BrowserView } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let mainWindow, topView, bottomView, config;

// Mitigate blank window on some GPUs / VMs
app.disableHardwareAcceleration();

function loadConfig() {
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [
    path.join(exeDir, 'config.json'),
    path.join(process.cwd(), 'config.json')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return normalize(JSON.parse(fs.readFileSync(p,'utf-8'))); } catch {}
  }
  return normalize({"topUrl": "https://awacs-portal2.icloud-prd.eu-west-1.aws.pmicloud.biz/speed/ro70-09-10/operators?plant=RO70&area=Secondary", "bottomUrl": "https://awacs-portal2.icloud-prd.eu-west-1.aws.pmicloud.biz/speed/ro70-11-12/operators?plant=RO70&area=Secondary", "dividerRatio": 0.55, "minWidth": 1200, "minHeight": 800, "userAgent": "", "lockToInitialOrigin": false});
}

function normalize(cfg) {
  return {
    topUrl: cfg.topUrl || 'https://example.com',
    bottomUrl: cfg.bottomUrl || 'https://example.com',
    dividerRatio: Math.min(0.9, Math.max(0.1, cfg.dividerRatio ?? 0.55)),
    minWidth: cfg.minWidth ?? 1000,
    minHeight: cfg.minHeight ?? 700,
    userAgent: cfg.userAgent || '',
    lockToInitialOrigin: cfg.lockToInitialOrigin ?? false
  };
}

function getOrigin(u) { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return ''; } }

function guardNavigation(view, initialUrl) {
  if (!config.lockToInitialOrigin) return;
  const origin = getOrigin(initialUrl);
  view.webContents.on('will-navigate', (e, url) => { if (getOrigin(url) !== origin) e.preventDefault(); });
  view.webContents.setWindowOpenHandler((d) => { return (getOrigin(d.url) !== origin) ? {action:'deny'} : {action:'allow'}; });
}

function layout() {
  if (!mainWindow || !topView || !bottomView) return;
  const [w,h] = mainWindow.getContentSize();
  const split = Math.round(h * config.dividerRatio);
  topView.setBounds({x:0,y:0,width:w,height:split});
  topView.setAutoResize({width:true,height:true});
  bottomView.setBounds({x:0,y:split,width:w,height:h-split});
  bottomView.setAutoResize({width:true,height:true});
}

function createWindow() {
  config = loadConfig();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    backgroundColor: '#111111',
    show: true,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration:false, contextIsolation:true, sandbox:true, backgroundThrottling:false }
  });

  topView = new BrowserView({ webPreferences: { contextIsolation:true, sandbox:true } });
  bottomView = new BrowserView({ webPreferences: { contextIsolation:true, sandbox:true } });

  mainWindow.setBrowserView(topView);
  mainWindow.addBrowserView(bottomView);

  const loadOpts = config.userAgent ? { userAgent: config.userAgent } : undefined;

  setTimeout(() => { try { mainWindow.show(); } catch {} }, 2000);

  topView.webContents.loadURL(config.topUrl, loadOpts).catch(()=>{});
  bottomView.webContents.loadURL(config.bottomUrl, loadOpts).catch(()=>{});

  guardNavigation(topView, config.topUrl);
  guardNavigation(bottomView, config.bottomUrl);

  mainWindow.on('resize', layout);
  mainWindow.on('ready-to-show', () => { layout(); try { mainWindow.show(); } catch {} });

  for (const wc of [topView.webContents, bottomView.webContents]) {
    wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
      console.error('did-fail-load', code, desc, validatedURL);
    });
    wc.on('crashed', () => console.error('webContents crashed'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
