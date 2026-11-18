/**
 * Crypsy Cloud Folder Sync & Provisioning Engine
 *
 * Uses the Browser File System Access API + IndexedDB handle persistence
 * to read/write the encrypted `vault.crypsy.json` directly inside a user's
 * synced Google Drive, OneDrive, Dropbox, or iCloud Drive folder.
 * Also supports provisioning a self-contained portable `Crypsy-Portable.html`
 * and `README-CRYPSY.txt` into the selected cloud directory.
 */

import type {
  CloudLocationInfo,
  CloudProviderConfig,
  CloudProviderId,
  CloudProviderMeta,
  EncryptedEnvelope,
  OsPlatform,
  RestoreConnectionResult,
} from './types';

const IDB_NAME = 'crypsy_cloud_sync_db_v1';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'active_cloud_dir_handle';
const META_STORAGE_KEY = 'crypsy_cloud_provider_meta_v1';

export const VAULT_FILENAME = 'vault.crypsy.json';
const README_FILENAME = 'README-CRYPSY.txt';
export const PORTABLE_HTML_FILENAME = 'Crypsy-Portable.html';

export const PROVIDERS: Record<CloudProviderId, CloudProviderConfig> = {
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

export type ExternalVaultUpdateCallback = (envelope: EncryptedEnvelope) => void;

let activeDirHandle: FileSystemDirectoryHandle | null = null;
let lastKnownFileModified = 0;
let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let onExternalVaultUpdateCallback: ExternalVaultUpdateCallback | null = null;

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function detectOS(): OsPlatform {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (ua.includes('win') || platform.includes('win')) return 'windows';
  if (ua.includes('mac') || platform.includes('mac')) return 'mac';
  return 'linux';
}

export function getProviderPathHint(providerId: CloudProviderId): string {
  const os = detectOS();
  const provider = PROVIDERS[providerId] ?? PROVIDERS.custom;
  return provider.paths[os] ?? provider.paths.windows;
}

/**
 * Detects if Crypsy is currently opened from a local file:// path inside
 * a known synced cloud storage folder (OneDrive, Google Drive, Dropbox, iCloud, etc.).
 */
export function detectRunningCloudLocation(): CloudLocationInfo | null {
  if (typeof window === 'undefined' || window.location.protocol !== 'file:') {
    return null;
  }

  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(window.location.pathname || '');
  } catch {
    decodedPath = window.location.pathname || '';
  }

  const normalized = decodedPath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();

  const rules: Array<{ id: CloudProviderId; name: string; patterns: string[] }> = [
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

  const parts = normalized.split('/').filter(Boolean);
  const folderName = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';

  for (const rule of rules) {
    if (rule.patterns.some((p) => lower.includes(p))) {
      return {
        isPortableFile: true,
        providerId: rule.id,
        providerName: rule.name,
        folderName,
        filePath: normalized,
      };
    }
  }

  return {
    isPortableFile: true,
    providerId: null,
    providerName: null,
    folderName,
    filePath: normalized,
  };
}

export function getLastKnownFileModified(): number | null {
  return lastKnownFileModified || null;
}

// IndexedDB helpers for persisting FileSystemDirectoryHandle across browser restarts
function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
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

async function saveDirHandleToIDB(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('Could not persist directory handle:', e);
  }
}

async function loadDirHandleFromIDB(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDB();
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function clearDirHandleFromIDB(): Promise<void> {
  try {
    const db = await openHandleDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

export function getSavedProviderMeta(): CloudProviderMeta | null {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CloudProviderMeta) : null;
  } catch {
    return null;
  }
}

function saveProviderMeta(meta: CloudProviderMeta): void {
  localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
}

function clearProviderMeta(): void {
  localStorage.removeItem(META_STORAGE_KEY);
}

async function verifyPermission(
  fileHandle: FileSystemHandle | null,
  readWrite = true
): Promise<boolean> {
  if (!fileHandle) return false;
  const opts: FileSystemHandlePermissionDescriptor = readWrite ? { mode: 'readwrite' } : {};
  return (await fileHandle.queryPermission(opts)) === 'granted';
}

async function requestPermission(
  fileHandle: FileSystemHandle | null,
  readWrite = true
): Promise<boolean> {
  if (!fileHandle) return false;
  const opts: FileSystemHandlePermissionDescriptor = readWrite ? { mode: 'readwrite' } : {};
  if ((await fileHandle.queryPermission(opts)) === 'granted') {
    return true;
  }
  return (await fileHandle.requestPermission(opts)) === 'granted';
}

/**
 * Prompts user to pick a cloud directory via native OS folder picker.
 * Optionally creates a `Crypsy` subfolder or uses the selected folder directly.
 */
export async function pickCloudFolder(
  providerId: CloudProviderId,
  createSubfolder = true
): Promise<CloudProviderMeta> {
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
  if (createSubfolder && pickedHandle.name.toLowerCase() !== 'crypsy') {
    targetHandle = await pickedHandle.getDirectoryHandle('Crypsy', {
      create: true,
    });
  }

  activeDirHandle = targetHandle;
  await saveDirHandleToIDB(targetHandle);

  const provider = PROVIDERS[providerId] ?? PROVIDERS.custom;
  const meta: CloudProviderMeta = {
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
 */
export async function restoreSavedConnection(): Promise<RestoreConnectionResult> {
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

export async function reconnectSavedHandle(): Promise<boolean> {
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

export async function unlinkCloudFolder(): Promise<void> {
  stopSyncPolling();
  activeDirHandle = null;
  await clearDirHandleFromIDB();
  clearProviderMeta();
}

/**
 * Reads `vault.crypsy.json` from the active cloud directory if it exists.
 */
export async function readVaultFromCloudFolder(): Promise<EncryptedEnvelope | null> {
  if (!activeDirHandle) return null;
  try {
    const fileHandle = await activeDirHandle.getFileHandle(VAULT_FILENAME, {
      create: false,
    });
    const file = await fileHandle.getFile();
    lastKnownFileModified = file.lastModified;
    const text = await file.text();
    return JSON.parse(text) as EncryptedEnvelope;
  } catch {
    // File does not exist yet in the folder
    return null;
  }
}

/**
 * Writes the encrypted AES-256-GCM envelope to `vault.crypsy.json` in the active cloud folder.
 */
export async function writeVaultToCloudFolder(envelope: EncryptedEnvelope): Promise<boolean> {
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
export async function provisionCloudFolderAssets(includePortableHtml = true): Promise<boolean> {
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
    const htmlHandle = await activeDirHandle.getFileHandle(PORTABLE_HTML_FILENAME, {
      create: true,
    });
    const htmlWritable = await htmlHandle.createWritable();
    await htmlWritable.write(portableHtml);
    await htmlWritable.close();
  }

  return true;
}

function sanitizeClonedPortableDom(): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  const clearIds = [
    'pinnedGrid',
    'othersGrid',
    'sidebarBoardsList',
    'sidebarTagsList',
    'composerImagesRow',
    'composerTagsRow',
    'editModalImagesRow',
    'editModalTagsRow',
    'boardItemsLayer',
    'boardTagsRow',
    'ciphertextPreview',
    'activeFilterText',
    'crypsyContextMenu',
  ];
  for (const id of clearIds) {
    const el = clone.querySelector(`#${id}`);
    if (el) el.innerHTML = '';
  }

  const hideIds = [
    'reconnectCloudBanner',
    'lastUpdatedBadge',
    'clearSearchBtn',
    'boardsActionBar',
    'composerHeader',
    'composerTagsRow',
    'composerImagesRow',
    'composerFooter',
    'composerTagPopover',
    'composerImagePopover',
    'activeFilterBanner',
    'pinnedSection',
    'othersSection',
    'emptyState',
    'editModalBackdrop',
    'editModalImagesRow',
    'editModalTagPopover',
    'editModalImagePopover',
    'boardEditorBackdrop',
    'boardSelectionBar',
    'boardTagPopover',
    'boardImagePopover',
    'boardLinkPopover',
    'boardMarqueeRect',
    'cloudOnboardingBackdrop',
    'vaultModalBackdrop',
    'updatesModalBackdrop',
    'lockScreenOverlay',
    'imageLightboxBackdrop',
    'crypsyContextMenu',
  ];
  for (const id of hideIds) {
    const el = clone.querySelector(`#${id}`);
    if (el) el.classList.add('hidden');
  }

  const cloudBtn = clone.querySelector('#cloudSetupBtn');
  if (cloudBtn) cloudBtn.classList.remove('synced', 'detected');
  const cloudLabel = clone.querySelector('#cloudSetupBtnLabel');
  if (cloudLabel) cloudLabel.textContent = 'Setup Cloud Folder';

  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

/**
 * Assembles a single self-contained HTML file right in the browser
 * so users can drop `Crypsy-Portable.html` into their cloud drive even without Node.js.
 */
export async function buildSelfContainedHtmlInBrowser(): Promise<string> {
  const linkRegex = /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/i;
  const scriptRegex = /<script\s+src="dist\/app\.bundle\.js"><\/script>/i;

  try {
    const [htmlRes, cssRes, bundleRes] = await Promise.all([
      fetch(window.location.href).then((r) => (r.ok ? r.text() : '')),
      fetch('styles.css').then((r) => (r.ok ? r.text() : '')),
      fetch('dist/app.bundle.js').then((r) => (r.ok ? r.text() : '')),
    ]);

    if (cssRes && bundleRes) {
      let baseHtml = htmlRes && linkRegex.test(htmlRes) && scriptRegex.test(htmlRes) ? htmlRes : '';
      if (!baseHtml) {
        const fallbackCandidates = ['app.html', 'index.html'];
        for (const candidate of fallbackCandidates) {
          const text = await fetch(candidate).then((r) => (r.ok ? r.text() : '')).catch(() => '');
          if (text && linkRegex.test(text) && scriptRegex.test(text)) {
            baseHtml = text;
            break;
          }
        }
      }
      if (baseHtml) {
        return baseHtml
          .replace(linkRegex, () => `<style>\n${cssRes}\n</` + 'style>')
          .replace(scriptRegex, () => `<script>\n${bundleRes}\n</` + 'script>');
      }
    }
  } catch {
    // Expected on file:// where fetch() is blocked by CORS
  }

  try {
    const portableRes = await fetch(PORTABLE_HTML_FILENAME).then((r) => (r.ok ? r.text() : ''));
    if (
      portableRes &&
      !linkRegex.test(portableRes) &&
      !scriptRegex.test(portableRes) &&
      /<style>[\s\S]*<\/style>/i.test(portableRes)
    ) {
      return portableRes;
    }
  } catch {
    // Ignore fetch failure on file://
  }

  const hasExternalCss = Boolean(document.querySelector('link[rel="stylesheet"][href="styles.css"]'));
  const hasExternalJs = Boolean(document.querySelector('script[src="dist/app.bundle.js"]'));
  const hasInlineCss = Array.from(document.querySelectorAll('style')).some(
    (s) => (s.textContent?.length ?? 0) > 500
  );

  if (!hasExternalCss && !hasExternalJs && hasInlineCss) {
    return sanitizeClonedPortableDom();
  }

  throw new Error(
    'Cannot bundle Crypsy-Portable.html when index.html is opened directly via file:// (browser blocks reading styles.css). Open Crypsy-Portable.html directly, or copy Crypsy-Portable.html to your cloud folder.'
  );
}

/**
 * Polls `vault.crypsy.json` in the cloud directory to detect changes synced from other devices.
 */
function startSyncPolling(): void {
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
      if (lastKnownFileModified > 0 && file.lastModified > lastKnownFileModified) {
        lastKnownFileModified = file.lastModified;
        const text = await file.text();
        const envelope = JSON.parse(text) as EncryptedEnvelope;
        onExternalVaultUpdateCallback(envelope);
      }
    } catch {
      // Ignore if file hasn't been created yet
    }
  }, 3500);
}

function stopSyncPolling(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

export function onExternalUpdate(cb: ExternalVaultUpdateCallback): void {
  onExternalVaultUpdateCallback = cb;
}

export function isConnected(): boolean {
  return Boolean(activeDirHandle);
}

export const CrypsyCloudSync = {
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

if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).CrypsyCloudSync = CrypsyCloudSync;
}
