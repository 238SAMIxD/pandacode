import { preview } from './bridge';
import { icon } from './dom';

/** Public project links. Opening one is user-initiated; nothing is contacted automatically. */
export const PROJECT_LINKS = {
  repository: 'https://github.com/aicodeking/pandacode',
  issues: 'https://github.com/aicodeking/pandacode/issues',
  releases: 'https://github.com/aicodeking/pandacode/releases',
  license: 'https://github.com/aicodeking/pandacode/blob/main/LICENSE',
} as const;

const link = (label: string, url: string) =>
  `<button type="button" class="secondary-button" data-action="open-url" data-url="${url}">${label}${icon('forward')}</button>`;

/** The About group: app version, license, and links. New versions are found on GitHub Releases. */
export function aboutSettingsHtml(): string {
  return `<div class="settings-group settings-about" aria-labelledby="settings-about-heading">
    <div class="setting-row"><div><strong id="settings-about-heading">About PandaCode</strong><small class="settings-about-version">Version …</small></div></div>
    <div class="setting-row"><div><strong>License</strong><small>Open source. No account, no telemetry.</small></div>${link('MIT License', PROJECT_LINKS.license)}</div>
    <div class="setting-row"><div><strong>Updates</strong><small>Never checked automatically.</small></div>${link('Releases on GitHub', PROJECT_LINKS.releases)}</div>
    <div class="setting-row"><div><strong>Source code</strong><small>Report bugs and follow development.</small></div><div class="settings-row-actions">${link('GitHub repository', PROJECT_LINKS.repository)}${link('Issues', PROJECT_LINKS.issues)}</div></div>
  </div>`;
}

/** Reads the bundle version from Tauri; the browser preview has no app bundle. */
async function appVersion(): Promise<string> {
  if (preview) return 'Preview';
  return (await import('@tauri-apps/api/app')).getVersion();
}

export function mountAboutSettings(host: HTMLElement): () => void {
  const version = host.querySelector<HTMLElement>('.settings-about-version');
  let disposed = false;
  if (version) {
    appVersion()
      .then(value => { if (!disposed) version.textContent = `Version ${value}`; })
      .catch(() => { if (!disposed) version.textContent = 'Version unavailable'; });
  }
  return () => { disposed = true; };
}
