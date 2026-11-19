// Packages Rede.app (macOS) into dist/app/Rede-darwin-<arch>/Rede.app.
// Run `npm run build` first (it builds dist/cli.js, dist/web and dist/app-src/main.cjs).
// With --install it copies the app to /Applications (else ~/Applications) and registers it,
// so rede:// links open it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packager } from '@electron/packager';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const f of ['cli.js', 'web/index.html', 'app-src/main.cjs']) {
  if (!fs.existsSync(path.join(dist, f))) throw new Error(`dist/${f} is missing. Run npm run build first.`);
}

// The app itself: only the main process bundle.
fs.writeFileSync(
  path.join(dist, 'app-src', 'package.json'),
  JSON.stringify({ name: 'rede', productName: 'Rede', version: pkg.version, main: 'main.cjs', license: pkg.license }, null, 2),
);
// The server it starts, outside the asar archive so Node (ELECTRON_RUN_AS_NODE) runs it as files.
const server = path.join(dist, 'app-res', 'server');
fs.rmSync(path.dirname(server), { recursive: true, force: true });
fs.mkdirSync(server, { recursive: true });
fs.copyFileSync(path.join(dist, 'cli.js'), path.join(server, 'cli.js'));
fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify({ type: 'module' }));
fs.cpSync(path.join(dist, 'web'), path.join(server, 'web'), { recursive: true });

const [out] = await packager({
  dir: path.join(dist, 'app-src'),
  out: path.join(dist, 'app'),
  name: 'Rede',
  executableName: 'Rede',
  appBundleId: 'dev.rede.app',
  appCategoryType: 'public.app-category.developer-tools',
  appVersion: pkg.version,
  icon: path.join(root, 'app', 'icon.icns'),
  protocols: [{ name: 'Rede review', schemes: ['rede'] }],
  extraResource: [server],
  darwinDarkModeSupport: true,
  asar: true,
  overwrite: true,
  platform: 'darwin',
  arch: process.arch,
  quiet: true,
});
const appPath = path.join(out, 'Rede.app');
// Local build: an ad-hoc signature keeps the renamed bundle valid on Apple silicon.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
console.log(`Built ${path.relative(root, appPath)}`);

if (process.argv.includes('--install')) {
  const target = (() => {
    try {
      fs.accessSync('/Applications', fs.constants.W_OK);
      return '/Applications';
    } catch {
      const dir = path.join(os.homedir(), 'Applications');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  })();
  const dest = path.join(target, 'Rede.app');
  // Quit a running copy first, so the new one is what opens next.
  try {
    execFileSync('osascript', ['-e', 'if application id "dev.rede.app" is running then tell application id "dev.rede.app" to quit'], { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('ditto', [appPath, dest]);
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dest]);
  console.log(`Installed ${dest}`);
}
