/**
 * Crypsy — Settings & GitHub Releases Update Checker Controller
 */

import { APP_VERSION, byId, escapeHtml } from '../utils';

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
}

export function compareSemver(a: string, b: string): number {
  const pa = String(a || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export interface UpdatesHost {
  getAutoCheckUpdates: () => boolean;
  setAutoCheckUpdates: (enabled: boolean) => void;
}

export class UpdatesController {
  private readonly host: UpdatesHost;
  private readonly els = {
    appVersionBadge: byId('appVersionBadge'),
    topbarUpdatesBtn: byId<HTMLButtonElement>('topbarUpdatesBtn'),
    backdrop: byId('updatesModalBackdrop'),
    closeBtn: byId<HTMLButtonElement>('closeUpdatesModalBtn'),
    installedVersionLabel: byId('installedVersionLabel'),
    autoCheckUpdatesCb: byId<HTMLInputElement>('autoCheckUpdatesCb'),
    updateCheckStatus: byId('updateCheckStatus'),
    checkUpdatesNowBtn: byId<HTMLButtonElement>('checkUpdatesNowBtn'),
  };

  constructor(host: UpdatesHost) {
    this.host = host;
    this.bindEvents();
  }

  public init(): void {
    this.els.autoCheckUpdatesCb.checked = this.host.getAutoCheckUpdates();
    this.els.appVersionBadge.textContent = `v${APP_VERSION}`;
    this.els.appVersionBadge.title = `Crypsy Note v${APP_VERSION} — Click to check for updates`;
    this.els.installedVersionLabel.textContent = `v${APP_VERSION}`;
    if (this.host.getAutoCheckUpdates()) {
      void this.checkForUpdates(true);
    }
  }

  public isOpen(): boolean {
    return !this.els.backdrop.classList.contains('hidden');
  }

  public open(): void {
    this.els.autoCheckUpdatesCb.checked = this.host.getAutoCheckUpdates();
    this.els.installedVersionLabel.textContent = `v${APP_VERSION}`;
    this.els.backdrop.classList.remove('hidden');
  }

  public close(): void {
    this.els.backdrop.classList.add('hidden');
  }

  public async checkForUpdates(silent = false): Promise<void> {
    if (!silent) {
      this.els.updateCheckStatus.className = 'update-status-box';
      this.els.updateCheckStatus.textContent = 'Checking GitHub Releases...';
    }

    try {
      const res = await fetch(
        'https://api.github.com/repos/kurtisnotcurtis/crypsy/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' } }
      );
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('No published GitHub Releases found yet.');
        }
        throw new Error(`GitHub API returned ${res.status}`);
      }

      const release = (await res.json()) as GitHubReleaseResponse;
      const latestTag = release.tag_name || release.name || '';
      const isNewer = compareSemver(latestTag, APP_VERSION) > 0;
      const portableAsset = Array.isArray(release.assets)
        ? release.assets.find((a) => a.name && a.name.toLowerCase().includes('portable'))
        : undefined;
      const downloadUrl =
        portableAsset?.browser_download_url ||
        release.html_url ||
        'https://github.com/kurtisnotcurtis/crypsy/releases/latest';

      if (isNewer) {
        this.els.appVersionBadge.classList.add('update-available');
        this.els.appVersionBadge.textContent = `v${APP_VERSION} • Update`;
        this.els.appVersionBadge.title = `Update available: ${latestTag}`;
        this.els.updateCheckStatus.className = 'update-status-box has-update';
        this.els.updateCheckStatus.innerHTML = `
          <div><strong>Update available: ${escapeHtml(latestTag)}</strong> (installed: v${escapeHtml(APP_VERSION)})</div>
          <div class="update-actions-row">
            <a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-primary" style="text-decoration:none;">Download ${escapeHtml(latestTag)}</a>
            <a href="${escapeHtml(release.html_url || downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-link">Release Notes</a>
          </div>
        `;
      } else {
        this.els.appVersionBadge.classList.remove('update-available');
        this.els.appVersionBadge.textContent = `v${APP_VERSION}`;
        this.els.updateCheckStatus.className = 'update-status-box up-to-date';
        this.els.updateCheckStatus.innerHTML = `You're up to date on <strong>v${escapeHtml(APP_VERSION)}</strong> (latest: ${escapeHtml(latestTag || `v${APP_VERSION}`)}).`;
      }
    } catch (err) {
      if (!silent) {
        this.els.updateCheckStatus.className = 'update-status-box error';
        const msg = err instanceof Error ? err.message : 'Network error';
        this.els.updateCheckStatus.textContent = `Could not check for updates: ${msg || 'Network error'}`;
      }
    }
  }

  private bindEvents(): void {
    this.els.appVersionBadge.addEventListener('click', () => this.open());
    this.els.topbarUpdatesBtn.addEventListener('click', () => this.open());
    this.els.closeBtn.addEventListener('click', () => this.close());
    this.els.backdrop.addEventListener('click', (e) => {
      if (e.target === this.els.backdrop) this.close();
    });
    this.els.autoCheckUpdatesCb.addEventListener('change', () => {
      const enabled = this.els.autoCheckUpdatesCb.checked;
      this.host.setAutoCheckUpdates(enabled);
      if (enabled) {
        void this.checkForUpdates(false);
      }
    });
    this.els.checkUpdatesNowBtn.addEventListener('click', () => {
      void this.checkForUpdates(false);
    });
  }
}
