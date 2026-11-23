/**
 * Crypsy — Lock Screen & Vault Passphrase Setup / Unlock / Upgrade Controller
 */

import {
  isConnected,
  isFileSystemAccessSupported,
  pickCloudFolder,
  readVaultFromCloudFolder,
} from './cloud-sync';
import { MIN_PASSPHRASE_LENGTH, VaultDecryptionError } from './crypto';
import type { CloudProviderId, EncryptedEnvelope } from '../types';
import { byId } from '../utils';

export type LockScreenMode = 'unlock' | 'setup' | 'upgrade';

export interface LockScreenHost {
  isPendingCloudPermission: () => boolean;
  getSelectedProviderId: () => CloudProviderId;
  validateNewPassphrase: (pass: string, confirm: string) => string | null;
  onCreateOrUpgradeVault: (mode: 'setup' | 'upgrade', passphrase: string) => Promise<void>;
  onUnlockVault: (passphrase: string) => Promise<void>;
  onTryLegacyUpgrade: () => Promise<boolean>;
  onCancelPendingImport: () => void;
  onResumeCloudSync: () => Promise<{ reconnected: boolean; error?: string }>;
  onCloudStatusConnected: () => void;
  onLoadCloudEnvelope: (envelope: EncryptedEnvelope) => Promise<void>;
  onImportVaultFile: (file: File) => Promise<void>;
}

interface LockScreenElements {
  overlay: HTMLElement;
  title: HTMLElement;
  subtitle: HTMLElement;
  form: HTMLFormElement;
  passphraseInput: HTMLInputElement;
  confirmWrapper: HTMLElement;
  confirmPassphraseInput: HTMLInputElement;
  errorMsg: HTMLElement;
  submitBtn: HTMLButtonElement;
  resumeCloudBtn: HTMLButtonElement;
  linkCloudBtn: HTMLButtonElement;
  legacyUpgradeBtn: HTMLButtonElement;
  cancelImportBtn: HTMLButtonElement;
  importVaultInput: HTMLInputElement;
}

export class LockScreenController {
  private readonly host: LockScreenHost;
  private readonly els: LockScreenElements;
  private mode: LockScreenMode = 'unlock';

  constructor(host: LockScreenHost) {
    this.host = host;
    this.els = {
      overlay: byId('lockScreenOverlay'),
      title: byId('lockScreenTitle'),
      subtitle: byId('lockScreenSubtitle'),
      form: byId<HTMLFormElement>('unlockVaultForm'),
      passphraseInput: byId<HTMLInputElement>('unlockPassphraseInput'),
      confirmWrapper: byId('unlockConfirmWrapper'),
      confirmPassphraseInput: byId<HTMLInputElement>('unlockConfirmPassphraseInput'),
      errorMsg: byId('unlockErrorMsg'),
      submitBtn: byId<HTMLButtonElement>('unlockSubmitBtn'),
      resumeCloudBtn: byId<HTMLButtonElement>('lockResumeCloudBtn'),
      linkCloudBtn: byId<HTMLButtonElement>('lockLinkCloudBtn'),
      legacyUpgradeBtn: byId<HTMLButtonElement>('lockLegacyUpgradeBtn'),
      cancelImportBtn: byId<HTMLButtonElement>('lockCancelImportBtn'),
      importVaultInput: byId<HTMLInputElement>('lockImportVaultInput'),
    };
    this.bindEvents();
  }

  public getOverlayEl(): HTMLElement {
    return this.els.overlay;
  }

  public isOpen(): boolean {
    return !this.els.overlay.classList.contains('hidden');
  }

  public hide(): void {
    this.els.passphraseInput.value = '';
    this.els.confirmPassphraseInput.value = '';
    this.els.errorMsg.classList.add('hidden');
    this.els.overlay.classList.add('hidden');
  }

  public setMode(
    mode: LockScreenMode,
    errorMsg?: string,
    options: { canCancelImport?: boolean } = {}
  ): void {
    this.mode = mode;
    const isCreate = mode === 'setup' || mode === 'upgrade';

    if (mode === 'setup') {
      this.els.title.textContent = 'Create Your Vault Passphrase';
      this.els.subtitle.textContent =
        'Your passphrase derives the AES-256-GCM encryption key locally and is never stored. If forgotten, your vault cannot be recovered.';
      this.els.passphraseInput.placeholder = `Create passphrase (min ${MIN_PASSPHRASE_LENGTH} chars)...`;
      this.els.submitBtn.textContent = 'Create Encrypted Vault';
    } else if (mode === 'upgrade') {
      this.els.title.textContent = 'Passphrase Required — Upgrade Vault';
      this.els.subtitle.textContent =
        'This vault was encrypted with Crypsy’s legacy default key. Set a strong passphrase now to re-encrypt your existing notes and boards.';
      this.els.passphraseInput.placeholder = `New passphrase (min ${MIN_PASSPHRASE_LENGTH} chars)...`;
      this.els.submitBtn.textContent = 'Re-key & Unlock Vault';
    } else {
      this.els.title.textContent = 'Crypsy Vault Locked';
      this.els.subtitle.textContent =
        'Your notes are encrypted with AES-256-GCM. Enter your vault passphrase to decrypt locally.';
      this.els.passphraseInput.placeholder = 'Vault passphrase...';
      this.els.submitBtn.textContent = 'Decrypt & Unlock';
    }

    this.els.passphraseInput.setAttribute(
      'autocomplete',
      isCreate ? 'new-password' : 'current-password'
    );
    this.els.confirmWrapper.classList.toggle('hidden', !isCreate);
    this.els.confirmPassphraseInput.required = isCreate;
    this.els.passphraseInput.value = '';
    this.els.confirmPassphraseInput.value = '';

    if (errorMsg) {
      this.showError(errorMsg);
    } else {
      this.els.errorMsg.classList.add('hidden');
    }

    this.els.resumeCloudBtn.classList.toggle('hidden', !this.host.isPendingCloudPermission());
    this.els.linkCloudBtn.classList.toggle(
      'hidden',
      !(mode === 'setup' && isFileSystemAccessSupported() && !isConnected())
    );
    this.els.legacyUpgradeBtn.classList.toggle('hidden', mode !== 'unlock');
    this.els.cancelImportBtn.classList.toggle('hidden', !options.canCancelImport);

    this.els.overlay.classList.remove('hidden');
    this.els.passphraseInput.focus();
  }

  public showError(message: string): void {
    this.els.errorMsg.textContent = message;
    this.els.errorMsg.classList.remove('hidden');
  }

  private bindEvents(): void {
    this.els.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const attempt = this.els.passphraseInput.value;
      this.els.errorMsg.classList.add('hidden');

      if (this.mode === 'setup' || this.mode === 'upgrade') {
        const confirm = this.els.confirmPassphraseInput.value;
        const validationError = this.host.validateNewPassphrase(attempt, confirm);
        if (validationError) {
          this.showError(validationError);
          return;
        }

        const prevBtnText = this.els.submitBtn.textContent;
        this.els.submitBtn.disabled = true;
        this.els.submitBtn.textContent = 'Encrypting...';
        try {
          await this.host.onCreateOrUpgradeVault(this.mode, attempt);
          this.hide();
        } catch (err) {
          this.showError(
            err instanceof Error ? err.message : 'Failed to create encrypted vault.'
          );
        } finally {
          this.els.submitBtn.disabled = false;
          this.els.submitBtn.textContent = prevBtnText;
        }
        return;
      }

      const prevBtnText = this.els.submitBtn.textContent;
      this.els.submitBtn.disabled = true;
      this.els.submitBtn.textContent = 'Decrypting...';
      try {
        await this.host.onUnlockVault(attempt);
        this.hide();
      } catch (err) {
        if (err instanceof VaultDecryptionError) {
          this.showError(err.message);
        } else {
          this.showError(
            err instanceof Error ? err.message : 'Failed to open decrypted vault.'
          );
        }
      } finally {
        this.els.submitBtn.disabled = false;
        this.els.submitBtn.textContent = prevBtnText;
      }
    });

    this.els.resumeCloudBtn.addEventListener('click', async () => {
      try {
        const res = await this.host.onResumeCloudSync();
        if (!res.reconnected) return;
        this.els.resumeCloudBtn.classList.add('hidden');
        if (res.error) {
          this.showError(res.error);
        }
      } catch (err) {
        this.showError(
          err instanceof Error ? err.message : 'Could not resume cloud folder sync.'
        );
      }
    });

    this.els.linkCloudBtn.addEventListener('click', async () => {
      try {
        await pickCloudFolder(this.host.getSelectedProviderId(), true);
        this.host.onCloudStatusConnected();
        const readRes = await readVaultFromCloudFolder();
        if (readRes.status === 'ok') {
          await this.host.onLoadCloudEnvelope(readRes.envelope);
        } else if (readRes.status === 'not_found') {
          this.setMode(
            'setup',
            'Cloud folder linked (no existing vault found). Create a passphrase above to initialize your vault.'
          );
        } else if (readRes.status === 'corrupt' || readRes.status === 'error') {
          this.showError(readRes.message);
        } else {
          this.showError('Cloud folder permission was not granted.');
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.showError(err instanceof Error ? err.message : 'Could not link cloud folder.');
      }
    });

    this.els.legacyUpgradeBtn.addEventListener('click', async () => {
      this.els.errorMsg.classList.add('hidden');
      try {
        await this.host.onTryLegacyUpgrade();
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Could not migrate legacy vault.');
      }
    });

    this.els.cancelImportBtn.addEventListener('click', () => {
      this.host.onCancelPendingImport();
    });

    this.els.importVaultInput.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      await this.host.onImportVaultFile(file);
      input.value = '';
    });
  }
}
