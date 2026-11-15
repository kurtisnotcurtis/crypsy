/**
 * Crypsy Cloud Folder Sync & Provisioning Engine
 *
 * Uses the Browser File System Access API + IndexedDB handle persistence
 * to read/write the encrypted `vault.crypsy.json` directly inside a user's
 * synced Google Drive, OneDrive, Dropbox, or iCloud Drive folder.
 * Also supports provisioning a self-contained portable `Crypsy-Portable.html`
 * and `README-CRYPSY.txt` into the selected cloud directory.
 */

const CrypsyCloudSync = (() => {
  const IDB_NAME = 'crypsy_cloud_sync_db_v1';
  const IDB_STORE = 'handles';
  const HANDLE_KEY = 'active_cloud_dir_handle';
  const META_STORAGE_KEY = 'crypsy_cloud_provider_meta_v1';
  const VAULT_FILENAME = 'vault.crypsy.json';
  const README_FILENAME = 'README-CRYPSY.txt';
  const PORTABLE_HTML_FILENAME = 'Crypsy-Portable.html';

  const PROVIDERS = {
    gdrive: {
      id: 'gdrive',
      name: 'Google Drive',
      tagline: 'Sync via Google Drive for Desktop',
      paths: {
        windows: 'G:\\My Drive\\Crypsy   or   %UserProfile%\\Google Drive\\Crypsy',
        mac: '~/Library/CloudStorage/GoogleDrive/My Drive/Crypsy',
        linux: '~/GoogleDrive/Crypsy',
      },
      folderHint: 'Select your "My Drive" folder (or a "Crypsy" folder inside it)',
    },
    onedrive: {
      id: 'onedrive',
      name: 'Microsoft OneDrive',
      tagline: 'Sync via Windows / macOS OneDrive Client',
      paths: {
        windows: '%UserProfile%\\OneDrive\\Crypsy',
        mac: '~/Library/CloudStorage/OneDrive-Personal/Crypsy',
        linux: '~/OneDrive/Crypsy',
      },
      folderHint: 'Select your "OneDrive" folder (or a "Crypsy" folder inside it)',
    },
    dropbox: {
      id: 'dropbox',
      name: 'Dropbox',
      tagline: 'Sync via Dropbox Desktop Client',
      paths: {
        windows: '%UserProfile%\\Dropbox\\Crypsy',
        mac: '~/Library/CloudStorage/Dropbox/Crypsy',
        linux: '~/Dropbox/Crypsy',
      },
      folderHint: 'Select your "Dropbox" folder (or a "Crypsy" folder inside it)',
    },
    icloud: {
      id: 'icloud',
      name: 'iCloud Drive',
      tagline: 'Sync via Apple iCloud Drive',
      paths: {
        windows: '%UserProfile%\\iCloudDrive\\Crypsy',
        mac: '~/Library/Mobile Documents/com~apple~CloudDocs/Crypsy',
        linux: '~/iCloud/Crypsy',
      },
      folderHint: 'Select your "iCloud Drive" folder (or a "Crypsy" folder inside it)',
    },
    custom: {
      id: 'custom',
      name: 'Nextcloud / Syncthing / Custom',
      tagline: 'Any local synced folder or USB drive',
      paths: {
        windows: 'C:\\Users\\You\\Sync\\Crypsy',
        mac: '~/Sync/Crypsy',
        linux: '~/Sync/Crypsy',
      },
      folderHint: 'Select any folder synced by your preferred tool',
    },
  };

  let activeDirHandle = null;
  let lastKnownFileModified = 0;
  let pollIntervalId = null;
  let onExternalVaultUpdateCallback = null;

  function isFileSystemAccessSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  function detectOS() {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    if (ua.includes('win') || platform.includes('win')) return 'windows';
    if (ua.includes('mac') || platform.includes('mac')) return 'mac';
    return 'linux';
  }

  function getProviderPathHint(providerId) {
    const os = detectOS();
    const provider = PROVIDERS[providerId] || PROVIDERS.custom;
    return provider.paths[os] || provider.paths.windows;
  }

  /**
   * Detects if Crypsy is currently opened from a local file:// path inside
   * a known synced cloud storage folder (OneDrive, Google Drive, Dropbox, iCloud, etc.).
   */
  function detectRunningCloudLocation() {
    if (typeof window === 'undefined' || window.location.protocol !== 'file:') {
      return null;
    }

    let decodedPath = '';
    try {
      decodedPath = decodeURIComponent(window.location.pathname || '');
    } catch (e) {
      decodedPath = window.location.pathname || '';
    }

    const normalized = decodedPath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();

    const rules = [
      { id: 'onedrive', name: 'OneDrive', patterns: ['/onedrive'] },
      { id: 'gdrive', name: 'Google Drive', patterns: ['/my drive/', '/google drive/', '/googledrive'] },
      { id: 'dropbox', name: 'Dropbox', patterns: ['/dropbox/'] },
      { id: 'icloud', name: 'iCloud Drive', patterns: ['/iclouddrive/', '/icloud drive/', '/com~apple~clouddocs/'] },
      { id: 'custom', name: 'Nextcloud', patterns: ['/nextcloud/'] },
      { id: 'custom', name: 'Syncthing', patterns: ['/syncthing/'] },
      { id: 'custom', name: 'ownCloud', patterns: ['/owncloud/'] },
      { id: 'custom', name: 'pCloud', patterns: ['/pcloud'] },
      { id: 'custom', name: 'Box', patterns: ['/box/'] },
    ];

    for (const rule of rules) {
      if (rule.patterns.some((p) => lower.includes(p))) {
        const parts = normalized.split('/').filter(Boolean);
        const folderName = parts.length >= 2 ? parts[parts.length - 2] : '';
        return {
          isPortableFile: true,
          providerId: rule.id,
          providerName: rule.name,
          folderName,
          filePath: normalized,
        };
      }
    }

    const parts = normalized.split('/').filter(Boolean);
    const folderName = parts.length >= 2 ? parts[parts.length - 2] : '';
    return {
      isPortableFile: true,
      providerId: null,
      providerName: null,
      folderName,
      filePath: normalized,
    };
  }

  function getLastKnownFileModified() {
    return lastKnownFileModified || null;
  }

  // IndexedDB helpers for persisting FileSystemDirectoryHandle across browser restarts
  function openHandleDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        return reject(new Error('IndexedDB not supported'));
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveDirHandleToIDB(handle) {
    try {
      const db = await openHandleDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('Could not persist directory handle:', e);
    }
  }

  async function loadDirHandleFromIDB() {
    try {
      const db = await openHandleDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }

  async function clearDirHandleFromIDB() {
    try {
      const db = await openHandleDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      // ignore
    }
  }

  function getSavedProviderMeta() {
    try {
      const raw = localStorage.getItem(META_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveProviderMeta(meta) {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  }

  function clearProviderMeta() {
    localStorage.removeItem(META_STORAGE_KEY);
  }

  async function verifyPermission(fileHandle, readWrite = true) {
    if (!fileHandle) return false;
    const opts = readWrite ? { mode: 'readwrite' } : {};
    if ((await fileHandle.queryPermission(opts)) === 'granted') {
      return true;
    }
    return false;
  }

  async function requestPermission(fileHandle, readWrite = true) {
    if (!fileHandle) return false;
    const opts = readWrite ? { mode: 'readwrite' } : {};
    if ((await fileHandle.queryPermission(opts)) === 'granted') {
      return true;
    }
    if ((await fileHandle.requestPermission(opts)) === 'granted') {
      return true;
    }
    return false;
  }

  /**
   * Prompts user to pick a cloud directory via native OS folder picker.
   * Optionally creates a `Crypsy` subfolder or uses the selected folder directly.
   */
  async function pickCloudFolder(providerId, createSubfolder = true) {
    if (!isFileSystemAccessSupported()) {
      throw new Error(
        'Your browser does not support direct folder linking (File System Access API). Use Chrome, Edge, or Brave, or run the local Crypsy installer script.'
      );
    }

    const pickedHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
    });

    let targetHandle = pickedHandle;
    // If the user selected the root of "OneDrive" or "My Drive" and asked for a subfolder, create/open "Crypsy"
    if (
      createSubfolder &&
      pickedHandle.name.toLowerCase() !== 'crypsy'
    ) {
      targetHandle = await pickedHandle.getDirectoryHandle('Crypsy', {
        create: true,
      });
    }

    activeDirHandle = targetHandle;
    await saveDirHandleToIDB(targetHandle);

    const provider = PROVIDERS[providerId] || PROVIDERS.custom;
    const meta = {
      providerId: provider.id,
      providerName: provider.name,
      folderName: targetHandle.name,
      parentFolderName: pickedHandle.name,
      linkedAt: new Date().toISOString(),
      lastSyncedAt: null,
    };
    saveProviderMeta(meta);
    startSyncPolling();
    return meta;
  }

  /**
   * Restores a previously saved directory handle on startup.
   * Returns { status: 'connected' | 'needs_permission' | 'unlinked', meta, handle }
   */
  async function restoreSavedConnection() {
    const meta = getSavedProviderMeta();
    const handle = await loadDirHandleFromIDB();
    if (!handle || !meta) {
      return { status: 'unlinked', meta: null };
    }

    activeDirHandle = handle;
    const hasPerm = await verifyPermission(handle, true);
    if (hasPerm) {
      startSyncPolling();
      return { status: 'connected', meta };
    }
    return { status: 'needs_permission', meta };
  }

  async function reconnectSavedHandle() {
    if (!activeDirHandle) {
      activeDirHandle = await loadDirHandleFromIDB();
    }
    if (!activeDirHandle) return false;
    const granted = await requestPermission(activeDirHandle, true);
    if (granted) {
      startSyncPolling();
    }
    return granted;
  }

  async function unlinkCloudFolder() {
    stopSyncPolling();
    activeDirHandle = null;
    await clearDirHandleFromIDB();
    clearProviderMeta();
  }

  /**
   * Reads `vault.crypsy.json` from the active cloud directory if it exists.
   */
  async function readVaultFromCloudFolder() {
    if (!activeDirHandle) return null;
    try {
      const fileHandle = await activeDirHandle.getFileHandle(VAULT_FILENAME, {
        create: false,
      });
      const file = await fileHandle.getFile();
      lastKnownFileModified = file.lastModified;
      const text = await file.text();
      return JSON.parse(text);
    } catch (e) {
      // File does not exist yet in the folder
      return null;
    }
  }

  /**
   * Writes the encrypted AES-256-GCM envelope to `vault.crypsy.json` in the active cloud folder.
   */
  async function writeVaultToCloudFolder(envelope) {
    if (!activeDirHandle) return false;
    const hasPerm = await verifyPermission(activeDirHandle, true);
    if (!hasPerm) return false;

    const fileHandle = await activeDirHandle.getFileHandle(VAULT_FILENAME, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(envelope, null, 2));
    await writable.close();

    const updatedFile = await fileHandle.getFile();
    lastKnownFileModified = updatedFile.lastModified;

    const meta = getSavedProviderMeta();
    if (meta) {
      meta.lastSyncedAt = new Date().toISOString();
      saveProviderMeta(meta);
    }
    return true;
  }

  /**
   * Provisions `README-CRYPSY.txt` and optionally a self-contained `Crypsy-Portable.html`
   * directly into the user's cloud folder so they can open Crypsy on any other synced computer.
   */
  async function provisionCloudFolderAssets(includePortableHtml = true) {
    if (!activeDirHandle) {
      throw new Error('No cloud folder linked yet.');
    }

    const readmeText = [
      '===================================================================',
      '  CRYPSY — TRANSPARENTLY ENCRYPTED CLOUD VAULT',
      '===================================================================',
      '',
      'This folder is managed by Crypsy and synced via your cloud provider.',
      '',
      'FILES IN THIS FOLDER:',
      `  1. ${VAULT_FILENAME}`,
      '     Your encrypted notes & tags payload (Cipher: AES-256-GCM,',
      '     Key Derivation: PBKDF2-SHA256, 150,000 iterations).',
      '     Do NOT delete or manually edit this file.',
      '',
      `  2. ${PORTABLE_HTML_FILENAME}`,
      '     Self-contained portable Crypsy web application.',
      '     On any computer where this cloud folder is synced, simply',
      `     open ${PORTABLE_HTML_FILENAME} in Chrome, Edge, or Brave and`,
      '     link this folder to read and edit your encrypted notes.',
      '',
      `Provisioned at: ${new Date().toISOString()}`,
      '===================================================================',
    ].join('\r\n');

    const readmeHandle = await activeDirHandle.getFileHandle(README_FILENAME, {
      create: true,
    });
    const readmeWritable = await readmeHandle.createWritable();
    await readmeWritable.write(readmeText);
    await readmeWritable.close();

    if (includePortableHtml) {
      const portableHtml = await buildSelfContainedHtmlInBrowser();
      const htmlHandle = await activeDirHandle.getFileHandle(
        PORTABLE_HTML_FILENAME,
        { create: true }
      );
      const htmlWritable = await htmlHandle.createWritable();
      await htmlWritable.write(portableHtml);
      await htmlWritable.close();
    }

    return true;
  }

  /**
   * Assembles a single self-contained HTML file right in the browser
   * so users can drop `Crypsy-Portable.html` into their cloud drive even without Node.js.
   */
  async function buildSelfContainedHtmlInBrowser() {
    try {
      const [htmlRes, cssRes, cryptoRes, syncRes, appRes] = await Promise.all([
        fetch(window.location.href).then((r) => (r.ok ? r.text() : '')),
        fetch('styles.css').then((r) => (r.ok ? r.text() : '')),
        fetch('crypto.js').then((r) => (r.ok ? r.text() : '')),
        fetch('cloud-sync.js').then((r) => (r.ok ? r.text() : '')),
        fetch('app.js').then((r) => (r.ok ? r.text() : '')),
      ]);

      if (cssRes && cryptoRes && appRes) {
        const baseHtml =
          htmlRes && /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/i.test(htmlRes)
            ? htmlRes
            : '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        return baseHtml
          .replace(
            /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/i,
            () => `<style>\n${cssRes}\n</` + 'style>'
          )
          .replace(
            /<script\s+src="crypto\.js"><\/script>/i,
            () => `<script>\n${cryptoRes}\n</` + 'script>'
          )
          .replace(
            /<script\s+src="cloud-sync\.js"><\/script>/i,
            () => `<script>\n${syncRes}\n</` + 'script>'
          )
          .replace(
            /<script\s+src="app\.js"><\/script>/i,
            () => `<script>\n${appRes}\n</` + 'script>'
          );
      }
    } catch (e) {
      // Fallback if running from a single-file bundle already (`file://` where fetch isn't needed)
    }
    return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  }

  /**
   * Polls `vault.crypsy.json` in the cloud directory to detect changes synced from other devices.
   */
  function startSyncPolling() {
    stopSyncPolling();
    pollIntervalId = setInterval(async () => {
      if (!activeDirHandle || !onExternalVaultUpdateCallback) return;
      try {
        const hasPerm = await verifyPermission(activeDirHandle, false);
        if (!hasPerm) return;
        const fileHandle = await activeDirHandle.getFileHandle(VAULT_FILENAME, {
          create: false,
        });
        const file = await fileHandle.getFile();
        if (
          lastKnownFileModified > 0 &&
          file.lastModified > lastKnownFileModified
        ) {
          lastKnownFileModified = file.lastModified;
          const text = await file.text();
          const envelope = JSON.parse(text);
          onExternalVaultUpdateCallback(envelope);
        }
      } catch (e) {
        // Ignore if file hasn't been created yet
      }
    }, 3500);
  }

  function stopSyncPolling() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  }

  function onExternalUpdate(cb) {
    onExternalVaultUpdateCallback = cb;
  }

  function isConnected() {
    return Boolean(activeDirHandle);
  }

  return {
    PROVIDERS,
    VAULT_FILENAME,
    PORTABLE_HTML_FILENAME,
    isFileSystemAccessSupported,
    detectOS,
    getProviderPathHint,
    detectRunningCloudLocation,
    getLastKnownFileModified,
    getSavedProviderMeta,
    pickCloudFolder,
    restoreSavedConnection,
    reconnectSavedHandle,
    unlinkCloudFolder,
    readVaultFromCloudFolder,
    writeVaultToCloudFolder,
    provisionCloudFolderAssets,
    buildSelfContainedHtmlInBrowser,
    onExternalUpdate,
    isConnected,
  };
})();
