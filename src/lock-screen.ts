/**
 * Crypsy — Lock Screen & Vault Passphrase Setup / Unlock / Upgrade Controller
 */

import { CrypsyCloudSync } from './cloud-sync';
import { MIN_PASSPHRASE_LENGTH } from './crypto';
import type { CloudProviderId, EncryptedEnvelope, VaultPayload } from './types';
import { byId } from './utils';

export type LockScreenMode = 'unlock' | 'setup' | 'upgrade';

export interface LockScreenHost {
  isPendingCloudPermission: () => boolean;
  clearPendingCloudPermission: () => void;
  getSelectedProviderId: () => CloudProviderId;
  validateNewPassphrase: (pass: string, confirm: string) => string | null;
  onCreateOrUpgradeVault: (mode: 'setup' | 'upgrade', passphrase: string) => Promise<void>;
  onUnlockVault: (passphrase: string) => Promise<void>;
  onCloudStatusConnected: () => void;
  onTryLoadEnvelope: (envelope: EncryptedEnvelope) => Promise<boolean>;
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

  public setMode(mode: LockScreenMode, errorMsg?: string): void {
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
      !(
        mode === 'setup' &&
        CrypsyCloudSync.isFileSystemAccessSupported() &&
        !CrypsyCloudSync.isConnected()
      )
    );

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
      } catch {
        this.showError(
          'Incorrect passphrase — AES-GCM authentication tag verification failed.'
        );
      } finally {
        this.els.submitBtn.disabled = false;
        this.els.submitBtn.textContent = prevBtnText;
      }
    });

    this.els.resumeCloudBtn.addEventListener('click', async () => {
      try {
        const ok = await CrypsyCloudSync.reconnectSavedHandle();
        if (!ok) return;
        this.host.clearPendingCloudPermission();
        this.els.resumeCloudBtn.classList.add('hidden');
        this.host.onCloudStatusConnected();
        const cloudEnvelope = await CrypsyCloudSync.readVaultFromCloudFolder();
        if (cloudEnvelope) {
          await this.host.onTryLoadEnvelope(cloudEnvelope);
        }
      } catch (err) {
        this.showError(
          err instanceof Error ? err.message : 'Could not resume cloud folder sync.'
        );
      }
    });

    this.els.linkCloudBtn.addEventListener('click', async () => {
      try {
        await CrypsyCloudSync.pickCloudFolder(this.host.getSelectedProviderId(), true);
        this.host.onCloudStatusConnected();
        const existingCloudVault = await CrypsyCloudSync.readVaultFromCloudFolder();
        if (existingCloudVault) {
          await this.host.onTryLoadEnvelope(existingCloudVault);
        } else {
          this.setMode(
            'setup',
            'Cloud folder linked (no existing vault found). Create a passphrase above to initialize your vault.'
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.showError(err instanceof Error ? err.message : 'Could not link cloud folder.');
      }
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

// Re-export type for convenience
export type { VaultPayload };
