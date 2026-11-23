/**
 * Crypsy Cloud Folder Sync & Provisioning Engine
 *
 * Uses the Browser File System Access API + IndexedDB handle persistence
 * to read/write the encrypted `vault.crypsy.json` directly inside a user's
 * synced Google Drive, OneDrive, Dropbox, or iCloud Drive folder.
 * Also supports provisioning a self-contained portable `Crypsy-Portable.html`
 * and `README-CRYPSY.txt` into the selected cloud directory.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type {
  CloudConnectionStatus,
  CloudFileStamp,
  CloudLocationInfo,
  CloudProviderConfig,
  CloudProviderId,
  CloudProviderMeta,
  CloudReadResult,
  CloudWriteResult,
  EncryptedEnvelope,
  OsPlatform,
  RestoreConnectionResult,
} from '../types';
import { idbDelete, idbGet, idbPut } from './cache';
import { envelopeFingerprint, isValidEncryptedEnvelope } from './crypto';

const IDB_NAME = 'crypsy_cloud_sync_db_v1';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'active_cloud_dir_handle';
const META_STORAGE_KEY = 'crypsy_cloud_provider_meta_v1';

export const VAULT_FILENAME = 'vault.crypsy.json';
const README_FILENAME = 'README-CRYPSY.txt';
export const PORTABLE_HTML_FILENAME = 'Crypsy-Portable.html';
const NATIVE_VAULT_PATH = `Crypsy/${VAULT_FILENAME}`;

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

export type ExternalVaultUpdateCallback = (
  envelope: EncryptedEnvelope,
  stamp: CloudFileStamp
) => void;

let activeDirHandle: FileSystemDirectoryHandle | null = null;
let hasGrantedPermission = false;
let lastAcceptedFileStamp: CloudFileStamp | null = null;
let lastNotifiedFingerprint: string | null = null;
let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let onExternalVaultUpdateCallback: ExternalVaultUpdateCallback | null = null;
let cleanPortableTemplateHtml: string | null = null;

/**
 * Captures the initial pristine standalone portable HTML before any user data is rendered.
 * Must be called once on startup before `initVault()`.
 */
export function captureCleanPortableTemplate(): void {
  if (typeof document === 'undefined') return;
  const hasExternalCss = Boolean(document.querySelector('link[rel="stylesheet"][href="styles.css"]'));
  const hasExternalJs = Boolean(document.querySelector('script[src="dist/app.bundle.js"]'));
  const hasInlineCss = Array.from(document.querySelectorAll('style')).some(
    (s) => (s.textContent?.length ?? 0) > 500
  );
  if (!hasExternalCss && !hasExternalJs && hasInlineCss) {
    cleanPortableTemplateHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  }
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function getNativePlatform(): string {
  return Capacitor.getPlatform();
}

function getNativeProviderMeta(): CloudProviderMeta {
  const existing = getSavedProviderMeta();
  const platform = getNativePlatform();
  return {
    providerId: 'custom',
    providerName: platform === 'ios' ? 'Files App' : 'Device Docs',
    folderName: 'Crypsy',
    parentFolderName: 'Documents',
    linkedAt: existing?.linkedAt ?? new Date().toISOString(),
    lastSyncedAt: existing?.lastSyncedAt ?? null,
  };
}

function isFileNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === 'NotFoundError' || e.code === 'ENOENT') return true;
  if (typeof e.message === 'string' && /not exist|not found|no such file/i.test(e.message)) {
    return true;
  }
  return false;
}

function isPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string };
  return e.name === 'NotAllowedError' || e.name === 'SecurityError';
}

async function readNativeVault(): Promise<CloudReadResult> {
  let sawError: string | null = null;
  for (const directory of [Directory.Documents, Directory.Data]) {
    try {
      const res = await Filesystem.readFile({
        path: NATIVE_VAULT_PATH,
        directory,
        encoding: Encoding.UTF8,
      });
      if (typeof res.data !== 'string' || !res.data.trim()) {
        return { status: 'corrupt', message: `${VAULT_FILENAME} is empty or unreadable.` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.data);
      } catch {
        return {
          status: 'corrupt',
          message: `${VAULT_FILENAME} contains invalid JSON and will not be overwritten.`,
        };
      }
      if (!isValidEncryptedEnvelope(parsed)) {
        return {
          status: 'corrupt',
          message: `${VAULT_FILENAME} is missing valid encrypted envelope fields.`,
        };
      }
      const stamp: CloudFileStamp = {
        lastModified: Date.now(),
        size: res.data.length,
        fingerprint: envelopeFingerprint(parsed),
      };
      return { status: 'ok', envelope: parsed, stamp };
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        sawError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (sawError) {
    return { status: 'error', message: sawError };
  }
  return { status: 'not_found' };
}

async function writeNativeVaultText(content: string): Promise<boolean> {
  for (const directory of [Directory.Documents, Directory.Data]) {
    try {
      await Filesystem.writeFile({
        path: NATIVE_VAULT_PATH,
        data: content,
        directory,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      return true;
    } catch {
      // Fall through to app-private Directory.Data if shared Documents is restricted
    }
  }
  return false;
}

/**
 * Shares an encrypted vault envelope via the native iOS/Android OS share sheet.
 */
export async function shareVaultWithNativeSheet(
  envelope: EncryptedEnvelope,
  filename: string
): Promise<boolean> {
  if (!isNativeApp()) return false;
  const content = JSON.stringify(envelope, null, 2);
  await Filesystem.writeFile({
    path: filename,
    data: content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({
    path: filename,
    directory: Directory.Cache,
  });
  await Share.share({
    title: 'Crypsy Encrypted Vault',
    files: [uri],
  });
  return true;
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
  return lastAcceptedFileStamp?.lastModified ?? null;
}

export function getLastAcceptedFileStamp(): CloudFileStamp | null {
  return lastAcceptedFileStamp;
}

export function markRemoteStampAccepted(stamp: CloudFileStamp | null): void {
  lastAcceptedFileStamp = stamp;
  lastNotifiedFingerprint = stamp?.fingerprint ?? null;
}

// IndexedDB helpers for persisting FileSystemDirectoryHandle across browser restarts
async function saveDirHandleToIDB(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await idbPut(IDB_NAME, IDB_STORE, HANDLE_KEY, handle);
  } catch (e) {
    console.warn('Could not persist directory handle:', e);
  }
}

async function loadDirHandleFromIDB(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await idbGet<FileSystemDirectoryHandle>(IDB_NAME, IDB_STORE, HANDLE_KEY);
  } catch {
    return null;
  }
}

async function clearDirHandleFromIDB(): Promise<void> {
  try {
    await idbDelete(IDB_NAME, IDB_STORE, HANDLE_KEY);
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
  try {
    return (await fileHandle.queryPermission(opts)) === 'granted';
  } catch {
    return false;
  }
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
  if (createSubfolder && pickedHandle.name.toLowerCase() !== 'crypsy') {
    targetHandle = await pickedHandle.getDirectoryHandle('Crypsy', {
      create: true,
    });
  }

  activeDirHandle = targetHandle;
  hasGrantedPermission = true;
  lastAcceptedFileStamp = null;
  lastNotifiedFingerprint = null;
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
  if (isNativeApp()) {
    const meta = getNativeProviderMeta();
    saveProviderMeta(meta);
    hasGrantedPermission = true;
    return { status: 'connected', meta };
  }

  const meta = getSavedProviderMeta();
  const handle = await loadDirHandleFromIDB();
  if (!handle || !meta) {
    activeDirHandle = null;
    hasGrantedPermission = false;
    return { status: 'unlinked', meta: null };
  }

  activeDirHandle = handle;
  const hasPerm = await verifyPermission(handle, true);
  hasGrantedPermission = hasPerm;
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
  if (!activeDirHandle) {
    hasGrantedPermission = false;
    return false;
  }
  const granted = await requestPermission(activeDirHandle, true);
  hasGrantedPermission = granted;
  if (granted) {
    startSyncPolling();
  }
  return granted;
}

export async function unlinkCloudFolder(): Promise<void> {
  stopSyncPolling();
  activeDirHandle = null;
  hasGrantedPermission = false;
  lastAcceptedFileStamp = null;
  lastNotifiedFingerprint = null;
  await clearDirHandleFromIDB();
  clearProviderMeta();
}

async function readCloudFileRaw(handle: FileSystemDirectoryHandle): Promise<CloudReadResult> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(VAULT_FILENAME, { create: false });
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { status: 'not_found' };
    }
    if (isPermissionDeniedError(err)) {
      hasGrantedPermission = false;
      return { status: 'no_permission' };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : `Could not open ${VAULT_FILENAME}.`,
    };
  }

  try {
    const file = await fileHandle.getFile();
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        status: 'corrupt',
        message: `${VAULT_FILENAME} is unreadable (invalid JSON) and was left untouched.`,
      };
    }
    if (!isValidEncryptedEnvelope(parsed)) {
      return {
        status: 'corrupt',
        message: `${VAULT_FILENAME} is malformed (invalid encrypted envelope) and was left untouched.`,
      };
    }
    const stamp: CloudFileStamp = {
      lastModified: file.lastModified,
      size: file.size,
      fingerprint: envelopeFingerprint(parsed),
    };
    return { status: 'ok', envelope: parsed, stamp };
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      hasGrantedPermission = false;
      return { status: 'no_permission' };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : `Could not read ${VAULT_FILENAME}.`,
    };
  }
}

/**
 * Reads `vault.crypsy.json` from the active cloud directory.
 * Returns `not_found` ONLY when the file does not exist; parse/shape errors return `corrupt`.
 */
export async function readVaultFromCloudFolder(): Promise<CloudReadResult> {
  if (isNativeApp()) {
    return readNativeVault();
  }
  if (!activeDirHandle) {
    return { status: 'unlinked' };
  }
  const hasPerm = await verifyPermission(activeDirHandle, false);
  if (!hasPerm) {
    hasGrantedPermission = false;
    return { status: 'no_permission' };
  }
  return readCloudFileRaw(activeDirHandle);
}

/**
 * Writes the encrypted AES-256-GCM envelope to `vault.crypsy.json` in the active cloud folder.
 * Refuses to overwrite if the file on disk changed since it was last read/written (unless `force: true`).
 */
export async function writeVaultToCloudFolder(
  envelope: EncryptedEnvelope,
  options: { force?: boolean; expectedFingerprint?: string | null } = {}
): Promise<CloudWriteResult> {
  const serialized = JSON.stringify(envelope, null, 2);

  if (isNativeApp()) {
    const ok = await writeNativeVaultText(serialized);
    if (!ok) {
      return { status: 'error', message: 'Failed to write encrypted vault to device storage.' };
    }
    const stamp: CloudFileStamp = {
      lastModified: Date.now(),
      size: serialized.length,
      fingerprint: envelopeFingerprint(envelope),
    };
    markRemoteStampAccepted(stamp);
    const meta = getNativeProviderMeta();
    meta.lastSyncedAt = new Date().toISOString();
    saveProviderMeta(meta);
    return { status: 'ok', stamp };
  }

  if (!activeDirHandle) {
    return { status: 'unlinked' };
  }
  const hasPerm = await verifyPermission(activeDirHandle, true);
  if (!hasPerm) {
    hasGrantedPermission = false;
    return { status: 'no_permission' };
  }
  hasGrantedPermission = true;

  // Optimistic concurrency check: refuse to overwrite a modified or corrupt remote file
  if (!options.force) {
    const existing = await readCloudFileRaw(activeDirHandle);
    if (existing.status === 'no_permission') {
      return { status: 'no_permission' };
    }
    if (existing.status === 'corrupt') {
      return {
        status: 'error',
        message: `${VAULT_FILENAME} on disk is unreadable; refusing to overwrite.`,
      };
    }
    if (existing.status === 'error') {
      return { status: 'error', message: existing.message };
    }
    if (existing.status === 'ok') {
      const expectedFp =
        options.expectedFingerprint !== undefined
          ? options.expectedFingerprint
          : lastAcceptedFileStamp?.fingerprint ?? null;
      if (expectedFp === null || existing.stamp.fingerprint !== expectedFp) {
        return {
          status: 'conflict',
          remoteEnvelope: existing.envelope,
          stamp: existing.stamp,
        };
      }
    }
  }

  try {
    const fileHandle = await activeDirHandle.getFileHandle(VAULT_FILENAME, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(serialized);
    await writable.close();

    const updatedFile = await fileHandle.getFile();
    const stamp: CloudFileStamp = {
      lastModified: updatedFile.lastModified,
      size: updatedFile.size,
      fingerprint: envelopeFingerprint(envelope),
    };
    markRemoteStampAccepted(stamp);

    const meta = getSavedProviderMeta();
    if (meta) {
      meta.lastSyncedAt = new Date().toISOString();
      saveProviderMeta(meta);
    }
    return { status: 'ok', stamp };
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      hasGrantedPermission = false;
      return { status: 'no_permission' };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : `Failed writing ${VAULT_FILENAME}.`,
    };
  }
}

/**
 * Provisions `README-CRYPSY.txt` and optionally a self-contained `Crypsy-Portable.html`
 * directly into the user's cloud folder so they can open Crypsy on any other synced computer.
 */
export async function provisionCloudFolderAssets(includePortableHtml = true): Promise<boolean> {
  if (!activeDirHandle || !hasGrantedPermission) {
    throw new Error('No cloud folder linked with write permission.');
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
    '     Key Derivation: PBKDF2-SHA256, 600,000 iterations).',
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

async function computeScriptSha256Csp(scriptBody: string): Promise<string> {
  const bytes = new TextEncoder().encode(scriptBody);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let binary = '';
  for (const b of arr) binary += String.fromCharCode(b);
  return `'sha256-${btoa(binary)}'`;
}

/**
 * Assembles a single self-contained HTML file right in the browser
 * so users can drop `Crypsy-Portable.html` into their cloud drive even without Node.js.
 */
export async function buildSelfContainedHtmlInBrowser(): Promise<string> {
  const linkRegex = /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/i;
  const scriptRegex = /<script\s+src="dist\/app\.bundle\.js"><\/script>/i;

  // 1. Prefer the prebuilt portable file when served over HTTP/HTTPS (single source of truth)
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
    // Expected on file:// where fetch() is blocked by CORS
  }

  // 2. Fallback: assemble from modular dev assets with SHA-256 CSP hash (no 'unsafe-inline' script)
  try {
    const [htmlRes, cssRes, bundleRes] = await Promise.all([
      fetch(window.location.href).then((r) => (r.ok ? r.text() : '')),
      fetch('styles.css').then((r) => (r.ok ? r.text() : '')),
      fetch('dist/app.bundle.js').then((r) => (r.ok ? r.text() : '')),
    ]);

    if (cssRes && bundleRes) {
      let baseHtml = htmlRes && linkRegex.test(htmlRes) && scriptRegex.test(htmlRes) ? htmlRes : '';
      if (!baseHtml) {
        for (const candidate of ['app.html', 'index.html']) {
          const text = await fetch(candidate).then((r) => (r.ok ? r.text() : '')).catch(() => '');
          if (text && linkRegex.test(text) && scriptRegex.test(text)) {
            baseHtml = text;
            break;
          }
        }
      }
      if (baseHtml) {
        const inlineScriptBody = `\n${bundleRes}\n`;
        const scriptHash = await computeScriptSha256Csp(inlineScriptBody);
        return baseHtml
          .replace(/<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"\s*\/?>\s*\r?\n?/i, '')
          .replace(/script-src\s+'self'/, `script-src ${scriptHash}`)
          .replace(linkRegex, () => `<style>\n${cssRes}\n</` + 'style>')
          .replace(scriptRegex, () => `<script>${inlineScriptBody}</` + 'script>');
      }
    }
  } catch {
    // Expected on file:// where fetch() is blocked by CORS
  }

  // 3. When running from an already self-contained Crypsy-Portable.html over file://,
  // return the pristine startup template captured before any vault data was decrypted.
  if (cleanPortableTemplateHtml) {
    return cleanPortableTemplateHtml;
  }

  throw new Error(
    'Cannot bundle Crypsy-Portable.html when index.html is opened directly via file:// (browser blocks reading styles.css). Open Crypsy-Portable.html directly, or copy Crypsy-Portable.html to your cloud folder.'
  );
}

/**
 * Polls `vault.crypsy.json` in the cloud directory to detect changes synced from other devices.
 * Does NOT advance `lastAcceptedFileStamp` — callers must call `markRemoteStampAccepted(stamp)`
 * once the remote envelope is actually applied.
 */
function startSyncPolling(): void {
  stopSyncPolling();
  pollIntervalId = setInterval(async () => {
    if (!activeDirHandle || !hasGrantedPermission || !onExternalVaultUpdateCallback) return;
    try {
      const hasPerm = await verifyPermission(activeDirHandle, false);
      if (!hasPerm) {
        hasGrantedPermission = false;
        return;
      }
      const res = await readCloudFileRaw(activeDirHandle);
      if (res.status !== 'ok') return;

      const acceptedFp = lastAcceptedFileStamp?.fingerprint ?? null;
      if (
        res.stamp.fingerprint !== acceptedFp &&
        res.stamp.fingerprint !== lastNotifiedFingerprint
      ) {
        lastNotifiedFingerprint = res.stamp.fingerprint;
        onExternalVaultUpdateCallback(res.envelope, res.stamp);
      }
    } catch {
      // Ignore transient poll errors
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

export function getConnectionStatus(): CloudConnectionStatus {
  if (isNativeApp()) return 'connected';
  if (activeDirHandle && hasGrantedPermission) return 'connected';
  if (activeDirHandle || getSavedProviderMeta()) return 'needs_permission';
  return 'unlinked';
}

export function isConnected(): boolean {
  return isNativeApp() || (Boolean(activeDirHandle) && hasGrantedPermission);
}
