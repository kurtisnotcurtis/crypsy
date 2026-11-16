#!/usr/bin/env node
/**
 * Crypsy Cross-Platform Cloud Installer & Single-File Bundler
 *
 * - Auto-detects installed cloud drives on Windows, macOS, and Linux
 *   (Microsoft OneDrive, Google Drive, Dropbox, Apple iCloud Drive).
 * - Bundles Crypsy into a single zero-dependency `Crypsy-Portable.html` file.
 * - Walks the user through placing the app and vault inside their cloud drive.
 *
 * Usage:
 *   node install.js                  # Interactive onboarding wizard
 *   node install.js --list           # List detected cloud folders on this machine
 *   node install.js --build-only     # Build dist/Crypsy-Portable.html without installing
 *   node install.js --target <path>  # Non-interactive install to <path>/Crypsy
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const ROOT_DIR = __dirname;
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '1.0.0';

/**
 * Bundles index.html + styles.css + dist/app.bundle.js
 * into a single self-contained HTML string.
 */
function buildPortableHtml() {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(ROOT_DIR, 'styles.css'), 'utf8');
  const bundleJs = fs.readFileSync(path.join(ROOT_DIR, 'dist', 'app.bundle.js'), 'utf8');

  return indexHtml
    .replace(
      /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/i,
      () => `<style>\n${stylesCss}\n</style>`
    )
    .replace(
      /<script\s+src="dist\/app\.bundle\.js"><\/script>/i,
      () => `<script>\n${bundleJs}\n</script>`
    );
}

function dirExists(p) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * Auto-detects synced cloud storage directories on Windows, macOS, and Linux.
 */
function detectCloudDrives() {
  const home = os.homedir();
  const platform = process.platform;
  const detected = [];
  const seenPaths = new Set();

  function addCandidate(provider, label, candidatePath) {
    if (!candidatePath) return;
    const normalized = path.resolve(candidatePath);
    if (seenPaths.has(normalized.toLowerCase())) return;
    if (dirExists(normalized)) {
      seenPaths.add(normalized.toLowerCase());
      detected.push({ provider, label, path: normalized });
    }
  }

  // 1. Microsoft OneDrive
  addCandidate('OneDrive', 'OneDrive (Personal)', process.env.OneDriveConsumer);
  addCandidate('OneDrive', 'OneDrive', process.env.OneDrive);
  addCandidate('OneDrive', 'OneDrive (Work/School)', process.env.OneDriveCommercial);
  addCandidate('OneDrive', 'OneDrive', path.join(home, 'OneDrive'));

  // 2. Google Drive
  if (platform === 'win32') {
    for (const driveLetter of ['G', 'H', 'I', 'D', 'E']) {
      addCandidate('Google Drive', `Google Drive (${driveLetter}:\\My Drive)`, `${driveLetter}:\\My Drive`);
    }
  }
  addCandidate('Google Drive', 'Google Drive', path.join(home, 'Google Drive'));
  addCandidate('Google Drive', 'Google Drive (My Drive)', path.join(home, 'Google Drive', 'My Drive'));
  addCandidate('Google Drive', 'Google Drive', path.join(home, 'GoogleDrive'));

  // 3. Dropbox (Check official info.json first, then standard paths)
  const dropboxInfoLocations = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Dropbox', 'info.json'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Dropbox', 'info.json'),
    path.join(home, '.dropbox', 'info.json'),
  ].filter(Boolean);

  for (const infoFile of dropboxInfoLocations) {
    try {
      if (fs.existsSync(infoFile)) {
        const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
        if (info.personal && info.personal.path) {
          addCandidate('Dropbox', 'Dropbox (Personal)', info.personal.path);
        }
        if (info.business && info.business.path) {
          addCandidate('Dropbox', 'Dropbox (Business)', info.business.path);
        }
      }
    } catch (e) {
      // ignore
    }
  }
  addCandidate('Dropbox', 'Dropbox', path.join(home, 'Dropbox'));

  // 4. Apple iCloud Drive
  addCandidate(
    'iCloud Drive',
    'iCloud Drive (macOS)',
    path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  );
  addCandidate('iCloud Drive', 'iCloud Drive (Windows)', path.join(home, 'iCloudDrive'));

  // 5. macOS CloudStorage unified mount directory (OneDrive, Google Drive, Dropbox, Box)
  const macCloudStorage = path.join(home, 'Library', 'CloudStorage');
  if (dirExists(macCloudStorage)) {
    try {
      for (const entry of fs.readdirSync(macCloudStorage)) {
        const full = path.join(macCloudStorage, entry);
        if (entry.startsWith('GoogleDrive')) {
          const myDrive = path.join(full, 'My Drive');
          addCandidate('Google Drive', `Google Drive (${entry})`, dirExists(myDrive) ? myDrive : full);
        } else if (entry.startsWith('OneDrive')) {
          addCandidate('OneDrive', `OneDrive (${entry})`, full);
        } else if (entry.startsWith('Dropbox')) {
          addCandidate('Dropbox', `Dropbox (${entry})`, full);
        } else {
          addCandidate('CloudStorage', entry, full);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 6. Nextcloud / Syncthing common folders
  addCandidate('Nextcloud', 'Nextcloud', path.join(home, 'Nextcloud'));
  addCandidate('Syncthing', 'Sync', path.join(home, 'Sync'));

  return detected;
}

/**
 * Installs Crypsy files into targetFolder (creates `Crypsy` subfolder if not already named `Crypsy`).
 */
function installToDirectory(baseDir, createSubfolder = true) {
  const targetDir =
    createSubfolder && path.basename(baseDir).toLowerCase() !== 'crypsy'
      ? path.join(baseDir, 'Crypsy')
      : baseDir;

  fs.mkdirSync(targetDir, { recursive: true });

  // 1. Write standalone single-file Crypsy-Portable.html
  const portableHtml = buildPortableHtml();
  const portablePath = path.join(targetDir, 'Crypsy-Portable.html');
  fs.writeFileSync(portablePath, portableHtml, 'utf8');

  // 2. Also copy modular source files for local development / inspection
  for (const file of ['index.html', 'styles.css', 'crypto.js', 'cloud-sync.js', 'app.js', 'logo.svg']) {
    const srcPath = path.join(ROOT_DIR, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(targetDir, file));
    }
  }

  // 3. Write README-CRYPSY.txt
  const readmeContent = [
    '===================================================================',
    '  CRYPSY — TRANSPARENTLY ENCRYPTED CLOUD VAULT',
    '===================================================================',
    '',
    `Installed Path : ${targetDir}`,
    `Installed Date : ${new Date().toISOString()}`,
    '',
    'HOW TO USE CRYPSY:',
    '  1. Open "Crypsy-Portable.html" (or "index.html") in Chrome, Edge, or Brave.',
    '  2. Click "Setup Cloud Folder" in the top-right bar and select this folder',
    `     (${targetDir}) so Crypsy auto-saves "vault.crypsy.json" here on every edit.`,
    '  3. On any other computer synced with this cloud provider, open',
    '     "Crypsy-Portable.html" directly from this folder!',
    '===================================================================',
  ].join(os.EOL);

  fs.writeFileSync(path.join(targetDir, 'README-CRYPSY.txt'), readmeContent, 'utf8');

  return { targetDir, portablePath };
}

/**
 * Creates a convenient Desktop internet/file shortcut (.url on Windows/macOS)
 */
function createDesktopShortcut(portableHtmlPath) {
  try {
    const desktopDir = path.join(os.homedir(), 'Desktop');
    if (!dirExists(desktopDir)) return null;
    const fileUrl = 'file:///' + portableHtmlPath.replace(/\\/g, '/');
    const shortcutPath = path.join(desktopDir, 'Crypsy Encrypted Notes.url');
    const content = `[InternetShortcut]\r\nURL=${fileUrl}\r\n`;
    fs.writeFileSync(shortcutPath, content, 'utf8');
    return shortcutPath;
  } catch (e) {
    return null;
  }
}

async function runInteractiveWizard() {
  console.log('\n================================================================');
  console.log(`  Crypsy v${PKG_VERSION} — Cross-Platform Cloud Folder Onboarding & Installer`);
  console.log('================================================================\n');

  const detected = detectCloudDrives();

  if (detected.length > 0) {
    console.log('Detected synced cloud folders on this machine:\n');
    detected.forEach((d, idx) => {
      console.log(`  [${idx + 1}] ${d.label.padEnd(28)} -> ${d.path}`);
    });
    console.log(`  [${detected.length + 1}] Enter a custom folder path\n`);
  } else {
    console.log('No standard cloud sync folders were auto-detected in default paths.\n');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

  try {
    let chosenBaseDir = null;

    if (detected.length > 0) {
      const choice = await ask(`Select a destination [1-${detected.length + 1}] (default: 1): `);
      const num = choice ? parseInt(choice, 10) : 1;
      if (num >= 1 && num <= detected.length) {
        chosenBaseDir = detected[num - 1].path;
      }
    }

    if (!chosenBaseDir) {
      const customPath = await ask('Enter target cloud folder path: ');
      if (!customPath) {
        console.log('Installation cancelled.');
        rl.close();
        return;
      }
      chosenBaseDir = path.resolve(customPath);
    }

    const { targetDir, portablePath } = installToDirectory(chosenBaseDir, true);
    console.log('\n[OK] Crypsy files placed in your cloud folder:');
    console.log(`     Folder   : ${targetDir}`);
    console.log(`     Portable : ${portablePath}`);

    const shortcutAns = await ask('\nCreate a Desktop shortcut to Crypsy? [Y/n]: ');
    if (!shortcutAns || shortcutAns.toLowerCase().startsWith('y')) {
      const shortcut = createDesktopShortcut(portablePath);
      if (shortcut) {
        console.log(`[OK] Desktop shortcut created: ${shortcut}`);
      }
    }

    console.log('\nNext step: Open Crypsy-Portable.html in your browser and click');
    console.log('"Setup Cloud Folder" to enable live auto-save to vault.crypsy.json!\n');
  } finally {
    rl.close();
  }
}

// CLI Entrypoint
(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`crypsy-note v${PKG_VERSION}`);
    return;
  }

  if (args.includes('--list')) {
    const detected = detectCloudDrives();
    console.log(JSON.stringify(detected, null, 2));
    return;
  }

  if (args.includes('--build-only')) {
    const html = buildPortableHtml();
    const outRoot = path.join(ROOT_DIR, 'Crypsy-Portable.html');
    fs.writeFileSync(outRoot, html, 'utf8');
    console.log(`Built standalone portable app: ${outRoot}`);
    return;
  }

  const targetIdx = args.indexOf('--target');
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    const target = path.resolve(args[targetIdx + 1]);
    const res = installToDirectory(target, true);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  await runInteractiveWizard();
})();
