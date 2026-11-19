/**
 * Rede.app: a window on the shared Rede server (the hub).
 *
 * The app does not hold review state. It makes sure the hub runs (it starts one with its bundled
 * CLI and Electron's own Node runtime when none runs), loads the hub's web UI, opens rede:// links,
 * and shows the number of reviews that wait for the human on the Dock icon. Closing the window
 * keeps the app (and its badge) running; the hub keeps running for CLI and browser users too.
 */
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureServer } from '../src/cli/client.ts';
import { redeHome } from '../src/server/hub.ts';
import type { HubEvent } from '../src/shared/types.ts';

app.setName('Rede');

/** The CLI bundle the app starts the hub with: inside the app, or dist/ when run from the checkout. */
function cliPath(): string {
  const packaged = path.join(process.resourcesPath, 'server', 'cli.js');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'cli.js');
}

let win: BrowserWindow | null = null;
let port = 0;
/** A rede:// link that arrived before the window was ready. */
let pendingLink: string | null = null;

const home = redeHome();
const origin = () => `http://127.0.0.1:${port}`;

async function startHub(): Promise<number> {
  const info = await ensureServer(cliPath(), home, { execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
  port = info.port;
  return port;
}

/** rede://open/<ws>/<review> -> /w/<ws>/r/<review>; rede://dashboard (or anything else) -> /. */
export function pathOfLink(link: string): string {
  try {
    const u = new URL(link);
    const parts = `${u.host}${u.pathname}`.split('/').filter(Boolean);
    if (parts[0] === 'open' && parts[1] && parts[2]) return `/w/${encodeURIComponent(decodeURIComponent(parts[1]))}/r/${encodeURIComponent(decodeURIComponent(parts[2]))}`;
    if (parts[0] === 'open' && parts[1]) return `/w/${encodeURIComponent(decodeURIComponent(parts[1]))}`;
  } catch {
    /* not a URL */
  }
  return '/';
}

// ------------------------------------------------------------------ window

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function savedBounds(): Electron.Rectangle | null {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return typeof b?.width === 'number' ? b : null;
  } catch {
    return null;
  }
}

function createWindow(initialPath = '/'): BrowserWindow {
  const b = savedBounds();
  const w = new BrowserWindow({
    width: b?.width ?? 1400,
    height: b?.height ?? 900,
    x: b?.x,
    y: b?.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Rede',
    backgroundColor: '#f4f4f2',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win = w;
  w.once('ready-to-show', () => w.show());
  w.webContents.on('did-finish-load', () => log(`loaded ${w.webContents.getURL()} title=${w.getTitle()}`));
  const save = () => {
    if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen()) {
      try {
        fs.writeFileSync(stateFile(), JSON.stringify(w.getBounds()));
      } catch {
        /* not fatal */
      }
    }
  };
  w.on('resize', save);
  w.on('move', save);
  w.on('closed', () => {
    if (win === w) win = null;
  });
  // Links to other sites open in the default browser; Rede pages stay in the window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin() + '/')) void w.loadURL(url);
    else void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin() + '/')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  // The hub went away (stopped, or replaced by a newer build): start it again and reload.
  w.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3: aborted by a newer navigation
    setTimeout(() => void recover(url), 600);
  });
  void w.loadURL(origin() + initialPath);
  return w;
}

let recovering = false;
async function recover(url: string): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    await startHub();
    const p = (() => {
      try {
        const u = new URL(url);
        return u.pathname + u.search + u.hash;
      } catch {
        return '/';
      }
    })();
    if (win && !win.isDestroyed()) await win.loadURL(origin() + p);
    watchBadge();
  } catch (e) {
    dialog.showErrorBox('Rede', `The Rede server does not start.\n\n${(e as Error).message}`);
  } finally {
    recovering = false;
  }
}

/** Shows a page: in the window when there is one, else in a new window. */
function show(p: string): void {
  if (!port) {
    pendingLink = p;
    return;
  }
  if (!win || win.isDestroyed()) createWindow(p);
  else {
    void win.loadURL(origin() + p);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
}

// ------------------------------------------------------------------ Dock badge

let badgeReq: http.ClientRequest | null = null;
let badgeRetry: NodeJS.Timeout | null = null;

/**
 * Follows the hub's event stream and shows the number of reviews that wait for the human (an
 * agent published them and the human has not opened them or marked them seen).
 */
function watchBadge(): void {
  if (badgeRetry) clearTimeout(badgeRetry);
  badgeRetry = null;
  badgeReq?.destroy();
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as HubEvent;
            if (ev.type === 'dashboard') setBadge(ev.awaiting);
          } catch {
            /* ignore */
          }
        }
      }
    });
    res.on('end', retry);
    res.on('error', retry);
  });
  req.on('error', retry);
  badgeReq = req;
  function retry() {
    if (badgeReq !== req) return;
    badgeReq = null;
    badgeRetry = setTimeout(() => {
      // The hub may be gone: start it again (never while the app quits).
      void startHub().then(watchBadge, () => (badgeRetry = setTimeout(watchBadge, 5000)));
    }, 2000);
  }
}

function setBadge(n: number): void {
  app.dock?.setBadge(n > 0 ? String(n) : '');
  log(`badge ${n}`);
}

/** REDE_APP_LOG=1: the app reports what it shows on stdout (for checks and debugging). */
function log(msg: string): void {
  if (process.env.REDE_APP_LOG) console.log(`[rede-app] ${msg}`);
}

// ------------------------------------------------------------------ menu

function run(js: string): void {
  void win?.webContents.executeJavaScript(js).catch(() => {});
}

function buildMenu(): void {
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Review ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => run(`window.rede?.gotoTab(${i + 1})`),
  }));
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Open in Browser', accelerator: 'CmdOrCtrl+Shift+O', click: () => win && void shell.openExternal(win.webContents.getURL()) },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+0', click: () => show('/') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win?.webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Previous Review', accelerator: 'CmdOrCtrl+Shift+[', click: () => run('window.rede?.stepTab(-1)') },
        { label: 'Next Review', accelerator: 'CmdOrCtrl+Shift+]', click: () => run('window.rede?.stepTab(1)') },
        { type: 'separator' },
        ...tabs,
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('rede://'));
    show(link ? pathOfLink(link) : '/');
  });
  // macOS delivers rede:// links with open-url, also the one that launched the app.
  app.on('will-finish-launching', () => {
    app.on('open-url', (e, url) => {
      e.preventDefault();
      show(pathOfLink(url));
    });
  });
  app.on('activate', () => {
    if (!win || win.isDestroyed()) show('/');
    else win.show();
  });
  // Closing the window keeps the app in the Dock with its badge (the macOS convention).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    if (badgeRetry) clearTimeout(badgeRetry);
    badgeReq?.destroy();
    badgeReq = null;
  });

  void app.whenReady().then(async () => {
    if (!app.isDefaultProtocolClient('rede')) app.setAsDefaultProtocolClient('rede');
    buildMenu();
    try {
      await startHub();
    } catch (e) {
      dialog.showErrorBox('Rede', `The Rede server does not start.\n\n${(e as Error).message}`);
      app.quit();
      return;
    }
    const link = process.argv.find((a) => a.startsWith('rede://'));
    const first = pendingLink ?? (link ? pathOfLink(link) : '/');
    pendingLink = null;
    createWindow(first);
    watchBadge();
  });
}
