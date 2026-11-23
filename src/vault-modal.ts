/**
 * Crypsy — Vault Inspector & Security Settings Modal Controller
 * Owns ciphertext preview, passphrase re-keying, auto-lock/privacy toggles,
 * manual lock button, and encrypted vault export/import controls.
 */

import type { EncryptedEnvelope } from './types';
import { byId, maybeById } from './utils';

export interface VaultModalHost {
  getLastEnvelope: () => EncryptedEnvelope | null;
  getAutoLockMinutes: () => number;
  setAutoLockMinutes: (minutes: number) => void;
  getLockOnHide: () => boolean;
  setLockOnHide: (enabled: boolean) => void;
  getBlockExternalMedia: () => boolean;
  setBlockExternalMedia: (enabled: boolean) => void;
  validateNewPassphrase: (pass: string, confirm: string) => string | null;
  onRekeyPassphrase: (nextPassphrase: string) => Promise<void>;
  onLockNow: () => Promise<void>;
  onExportVault: () => Promise<void>;
  onImportVaultFile: (file: File, backdropToClose?: HTMLElement) => Promise<void>;
}

interface VaultModalElements {
  backdrop: HTMLElement;
  closeBtn: HTMLButtonElement;
  passphraseInput: HTMLInputElement;
  confirmPassphraseInput: HTMLInputElement;
  passphraseFeedback: HTMLElement;
  updatePassphraseBtn: HTMLButtonElement;
  lockVaultNowBtn: HTMLButtonElement;
  ciphertextPreview: HTMLElement;
  exportEncryptedBtn: HTMLButtonElement;
  importEncryptedInput: HTMLInputElement;
  autoLockSelect: HTMLSelectElement | null;
  lockOnHideCb: HTMLInputElement | null;
  blockExternalMediaCb: HTMLInputElement | null;
}

export class VaultModalController {
  private readonly host: VaultModalHost;
  private readonly els: VaultModalElements;

  constructor(host: VaultModalHost) {
    this.host = host;
    this.els = {
      backdrop: byId('vaultModalBackdrop'),
      closeBtn: byId<HTMLButtonElement>('closeVaultModalBtn'),
      passphraseInput: byId<HTMLInputElement>('vaultPassphraseInput'),
      confirmPassphraseInput: byId<HTMLInputElement>('vaultConfirmPassphraseInput'),
      passphraseFeedback: byId('vaultPassphraseFeedback'),
      updatePassphraseBtn: byId<HTMLButtonElement>('updatePassphraseBtn'),
      lockVaultNowBtn: byId<HTMLButtonElement>('lockVaultNowBtn'),
      ciphertextPreview: byId('ciphertextPreview'),
      exportEncryptedBtn: byId<HTMLButtonElement>('exportEncryptedBtn'),
      importEncryptedInput: byId<HTMLInputElement>('importEncryptedInput'),
      autoLockSelect: maybeById<HTMLSelectElement>('autoLockSelect'),
      lockOnHideCb: maybeById<HTMLInputElement>('lockOnHideCb'),
      blockExternalMediaCb: maybeById<HTMLInputElement>('blockExternalMediaCb'),
    };
    this.bindEvents();
  }

  public isOpen(): boolean {
    return !this.els.backdrop.classList.contains('hidden');
  }

  public open(): void {
    this.updateCiphertextPreview();
    this.els.passphraseInput.value = '';
    this.els.confirmPassphraseInput.value = '';
    this.els.passphraseFeedback.className = 'vault-feedback hidden';
    this.els.passphraseFeedback.textContent = '';
    if (this.els.autoLockSelect) {
      this.els.autoLockSelect.value = String(this.host.getAutoLockMinutes());
    }
    if (this.els.lockOnHideCb) {
      this.els.lockOnHideCb.checked = this.host.getLockOnHide();
    }
    if (this.els.blockExternalMediaCb) {
      this.els.blockExternalMediaCb.checked = this.host.getBlockExternalMedia();
    }
    this.els.backdrop.classList.remove('hidden');
  }

  public close(): void {
    this.els.backdrop.classList.add('hidden');
  }

  public clearSensitiveUI(): void {
    this.els.passphraseInput.value = '';
    this.els.confirmPassphraseInput.value = '';
    this.els.ciphertextPreview.textContent = '';
    this.els.backdrop.classList.add('hidden');
  }

  public updateCiphertextPreview(): void {
    const env = this.host.getLastEnvelope();
    if (!env) return;
    const displayEnvelope =
      env.ciphertext && env.ciphertext.length > 1200
        ? {
            ...env,
            ciphertext: `${env.ciphertext.slice(0, 600)}... [${env.ciphertext.length.toLocaleString()} base64 chars encrypted]`,
          }
        : env;
    this.els.ciphertextPreview.textContent = JSON.stringify(displayEnvelope, null, 2);
  }

  private bindEvents(): void {
    this.els.closeBtn.addEventListener('click', () => this.close());
    this.els.backdrop.addEventListener('click', (e) => {
      if (e.target === this.els.backdrop) this.close();
    });

    this.els.autoLockSelect?.addEventListener('change', () => {
      if (!this.els.autoLockSelect) return;
      const val = parseInt(this.els.autoLockSelect.value, 10);
      this.host.setAutoLockMinutes(Number.isFinite(val) ? val : 15);
    });

    this.els.lockOnHideCb?.addEventListener('change', () => {
      if (!this.els.lockOnHideCb) return;
      this.host.setLockOnHide(this.els.lockOnHideCb.checked);
    });

    this.els.blockExternalMediaCb?.addEventListener('change', () => {
      if (!this.els.blockExternalMediaCb) return;
      this.host.setBlockExternalMedia(this.els.blockExternalMediaCb.checked);
    });

    this.els.updatePassphraseBtn.addEventListener('click', async () => {
      const nextPass = this.els.passphraseInput.value;
      const confirmPass = this.els.confirmPassphraseInput.value;
      const validationError = this.host.validateNewPassphrase(nextPass, confirmPass);
      if (validationError) {
        this.els.passphraseFeedback.className = 'vault-feedback error';
        this.els.passphraseFeedback.textContent = validationError;
        return;
      }
      const prevBtnText = this.els.updatePassphraseBtn.textContent;
      this.els.updatePassphraseBtn.disabled = true;
      this.els.updatePassphraseBtn.textContent = 'Encrypting...';
      try {
        await this.host.onRekeyPassphrase(nextPass);
        this.els.passphraseInput.value = '';
        this.els.confirmPassphraseInput.value = '';
        this.els.passphraseFeedback.className = 'vault-feedback success';
        this.els.passphraseFeedback.textContent =
          'Vault re-keyed and encrypted with your new passphrase.';
      } catch (err) {
        this.els.passphraseFeedback.className = 'vault-feedback error';
        this.els.passphraseFeedback.textContent =
          err instanceof Error ? err.message : 'Failed to re-key vault.';
      } finally {
        this.els.updatePassphraseBtn.disabled = false;
        this.els.updatePassphraseBtn.textContent = prevBtnText;
      }
    });

    this.els.lockVaultNowBtn.addEventListener('click', () => {
      void this.host.onLockNow();
    });

    this.els.exportEncryptedBtn.addEventListener('click', () => {
      void this.host.onExportVault();
    });

    this.els.importEncryptedInput.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      await this.host.onImportVaultFile(file, this.els.backdrop);
      input.value = '';
    });
  }
}
