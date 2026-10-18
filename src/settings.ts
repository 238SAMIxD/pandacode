import './settings.css';
import { mountProviderReadiness } from './provider-readiness';
import { escape, icon } from './dom';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import { uiSizeControls } from './ui-size';
import type { Provider, ProviderId } from './types';
import { mountOverlaySettings } from './overlay-settings';
import { mountSupportDetails } from './support-settings';
import { aboutSettingsHtml, mountAboutSettings } from './about-settings';
import { colorsSummary } from './theme-settings';
import { mountAgentTeams, type AgentTeamsOptions } from './agent-teams';
import { mountCloudSettings, type CloudSettingsHost } from './cloud-settings';

interface SettingsOptions {
  providers: Provider[];
  defaultProvider: ProviderId;
  compact: boolean;
  wallpapers: boolean;
  preview: boolean;
  discover(): Promise<Provider[]>;
  /** Mounts the optional GitHub row; returns its cleanup. */
  github?(host: HTMLElement): () => void;
  /** Named agent teams and the classic Team setup switch. */
  teams?: Omit<AgentTeamsOptions, 'providers'>;
  /** Cloud sandbox connections (Daytona, Cloudflare, AWS). */
  cloud?: CloudSettingsHost;
}

/** General controls are available immediately; agent discovery belongs to its own tab. */
export function mountSettings(host: HTMLElement, options: SettingsOptions): () => void {
  const defaultName = options.providers.find(provider => provider.id === options.defaultProvider)?.name ?? options.defaultProvider;
  host.classList.add('settings-home');
  host.innerHTML = `
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" id="settings-general-tab" role="tab" aria-selected="true" aria-controls="settings-general" tabindex="0">General</button>
      <button type="button" id="settings-agents-tab" role="tab" aria-selected="false" aria-controls="settings-agents" tabindex="-1">Agents</button>
    </div>
    <section id="settings-general" role="tabpanel" aria-labelledby="settings-general-tab">
      <div class="settings-group">
        ${uiSizeControls()}
        <div class="setting-row"><div><strong>Compact conversation</strong><small>Less space between messages.</small></div><input type="checkbox" class="settings-switch" id="compact-mode" aria-label="Compact conversation" ${options.compact ? 'checked' : ''}></div>
        <div class="setting-row"><div><strong>Colors</strong><small class="settings-colors-summary">${escape(colorsSummary())}</small></div><button type="button" class="secondary-button" data-action="colors-settings" aria-label="Customize colors" aria-haspopup="dialog">Customize${icon('chevron')}</button></div>
        <div class="setting-row settings-wallpaper-row"><div><strong>Wallpapers</strong><small>Scene, visibility, and blur.</small></div><div class="settings-row-actions"><button type="button" class="secondary-button" data-action="wallpaper-settings" aria-label="Customize wallpapers" aria-haspopup="dialog">Customize${icon('chevron')}</button><input type="checkbox" class="settings-switch" id="daily-wallpapers" aria-label="Daily wallpapers" ${options.wallpapers ? 'checked' : ''}></div></div>
      </div>
      <div id="launcher-settings"></div>
      <div id="github-settings"></div>
      ${aboutSettingsHtml()}
      <div class="settings-group settings-support"><div class="setting-row"><div><strong>Help & support</strong><small>Open an issue on GitHub.</small></div><button type="button" class="secondary-button" data-action="support">Open issues${icon('forward')}</button></div><details class="support-details"><summary>App details for support</summary><p>Only the app version, platform, and architecture. Nothing is sent automatically.</p><textarea aria-label="App details for support" rows="3" readonly spellcheck="false"></textarea><div class="support-details-actions"><button type="button" class="secondary-button support-copy" disabled>${icon('copy')}Copy app details</button><button type="button" class="secondary-button support-retry" hidden>Try again</button></div><p role="status" aria-live="polite"></p></details></div>
    </section>
    <section id="settings-agents" role="tabpanel" aria-labelledby="settings-agents-tab" hidden>
      <div class="settings-group">
        <div class="setting-row settings-default-row"><div><strong>Default agent</strong><small>Used for new tasks.</small></div><button type="button" id="default-provider" class="settings-select" data-action="default-provider" aria-label="Default agent for new tasks" aria-haspopup="dialog" aria-expanded="false">${providerLogo(options.defaultProvider)}<span>${escape(defaultName)}</span>${icon('down')}</button></div>
        <div class="setting-row"><div><strong>Tools & integrations</strong><small>App tools, MCP servers, and skills.</small></div><button type="button" class="secondary-button" data-action="agent-integrations">Manage</button></div>
        <div class="setting-row"><div><strong>Jev · Optional add-on</strong><small>Browser tests and decision assistance. Your agents work without it.</small></div><button type="button" class="secondary-button" data-action="jev-settings">Set up Jev</button></div>
        <div class="setting-row"><div><strong>Provider connections</strong><small>GLM Coding Plan, OpenCode, and Antigravity.</small></div><button type="button" class="secondary-button" data-action="provider-connections">Set up</button></div>
        <div class="setting-row"><div><strong>OpenCode models</strong><small>Choose which models appear in your selectors.</small></div><button type="button" class="secondary-button" data-action="opencode-models">Choose models</button></div>
        <div class="setting-row"><div><strong>Agent updates</strong><small>Keep installed agents up to date.</small></div><button type="button" class="secondary-button" data-action="agent-updates" aria-haspopup="dialog">Check updates</button></div>
      </div>
      <div id="agent-teams-settings"></div>
      <div class="settings-agents-heading"><h3>Cloud sandboxes</h3></div>
      <div id="cloud-settings"></div>
      <div class="settings-agents-heading"><h3>Installed agents</h3><button type="button" class="settings-refresh">${icon('refresh')}Refresh agents</button></div>
      <div class="settings-provider-status" role="status" hidden></div>
      <div class="provider-diagnostics settings-group"></div>
      ${options.preview ? '<p class="settings-preview-note">Browser preview · sample agent availability.</p>' : ''}
    </section>`;
  const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  const list = host.querySelector<HTMLElement>('.provider-diagnostics')!;
  const refreshButton = host.querySelector<HTMLButtonElement>('.settings-refresh')!;
  const status = host.querySelector<HTMLElement>('.settings-provider-status')!;
  const cleanupLauncher = mountOverlaySettings(host.querySelector<HTMLElement>('#launcher-settings')!);
  const cleanupGithub = options.github?.(host.querySelector<HTMLElement>('#github-settings')!) ?? (() => {});
  const teamsHost = host.querySelector<HTMLElement>('#agent-teams-settings')!;
  const cleanupTeams = options.teams ? mountAgentTeams(teamsHost, { ...options.teams, providers: options.providers }) : () => {};
  const cleanupCloud = options.cloud ? mountCloudSettings(host.querySelector<HTMLElement>('#cloud-settings')!, options.cloud) : () => {};
  const cleanupSupport = mountSupportDetails(host.querySelector<HTMLDetailsElement>('.support-details')!);
  const cleanupAbout = mountAboutSettings(host.querySelector<HTMLElement>('.settings-about')!);
  let disposed = false, pending = false, discovered = false;
  const readinessCleanup: (() => void)[] = [];
  const live = () => !disposed && host.isConnected && Boolean(host.closest('dialog[open]'));

  function updateProviders(providers: Provider[]): void {
    const rows = new Map(Array.from(list.querySelectorAll<HTMLDetailsElement>('details')).map(row => [row.dataset.provider!, row]));
    for (const [index, provider] of providers.entries()) {
      let row = rows.get(provider.id);
      if (!row) {
        row = document.createElement('details');
        row.className = 'provider-diagnostic'; row.dataset.provider = provider.id;
        row.innerHTML = `<summary aria-label="${escape(provider.name)} details"><span class="provider-avatar ${provider.id}">${providerLogo(provider.id)}</span><strong></strong><span class="provider-availability"><span class="status-dot"></span><span class="settings-installed"></span></span>${icon('chevron')}</summary><div class="settings-provider-details"><span>Version</span><span class="settings-provider-version"></span><span>Location</span><code></code></div>`;
      }
      if (provider.id === 'antigravity' && !row.querySelector('.provider-readiness')) {
        const check = document.createElement('div');
        row.append(check); readinessCleanup.push(mountProviderReadiness(check));
      }
      row.querySelector('strong')!.textContent = provider.name;
      row.querySelector('summary')!.setAttribute('aria-label', `${provider.name} details, ${provider.installed ? 'Installed' : 'Not installed'}`);
      row.querySelector('.provider-availability')!.classList.toggle('available', provider.installed);
      row.querySelector('.settings-installed')!.textContent = provider.installed ? (provider.id === 'antigravity' ? 'ACP installed' : 'Installed') : 'Not installed';
      row.querySelector('.settings-provider-version')!.textContent = provider.version || 'Not reported';
      row.querySelector('code')!.textContent = provider.path || 'Install the agent, then refresh.';
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      rows.delete(provider.id);
    }
    rows.forEach(row => row.remove());
  }
  async function refresh(): Promise<void> {
    if (!live() || pending) return;
    pending = true; refreshButton.disabled = true;
    status.hidden = false; status.textContent = 'Checking agents…';
    try {
      const providers = await options.discover();
      if (!live()) return;
      updateProviders(providers); discovered = true;
      status.textContent = ''; status.hidden = true;
    } catch {
      if (!live()) return;
      status.textContent = 'Couldn’t check agents. Try refreshing again.';
    } finally { pending = false; if (live()) refreshButton.disabled = false; }
  }
  function select(index: number, focus = false): void {
    tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index; });
    trackSegment(tabs[index].parentElement as HTMLElement, tabs[index]);
    if (focus) tabs[index].focus();
    if (index === 1 && !discovered) void refresh();
  }
  function click(event: MouseEvent): void {
    const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
    if (tab && tabs.includes(tab)) select(tabs.indexOf(tab));
  }
  function keydown(event: KeyboardEvent): void {
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    select(event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length, true);
  }
  updateProviders(options.providers);
  host.addEventListener('click', click);
  host.addEventListener('keydown', keydown);
  refreshButton.addEventListener('click', refresh);
  trackSegment(tabs[0].parentElement as HTMLElement, tabs[0]);
  tabs[0].focus({ preventScroll: true });
  return () => {
    disposed = true; readinessCleanup.forEach(cleanup => cleanup());
    cleanupLauncher();
    cleanupGithub();
    cleanupTeams();
    cleanupCloud();
    cleanupSupport(); cleanupAbout();
    host.removeEventListener('click', click); host.removeEventListener('keydown', keydown);
    refreshButton.removeEventListener('click', refresh);
    host.replaceChildren();
  };
}
