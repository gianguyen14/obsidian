import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { useStore } from '../lib/store';
import { api, type SecurityStatus } from '../lib/api';
import Icon from './Icon';
import PluginDomMount from './PluginDomMount';
import { renderMarkdown } from '../lib/markdown';
import type { ThemeSetting } from '../lib/theme';
import {
  disablePlugin,
  enablePlugin,
  getPluginRuntimeSnapshot,
  reloadPlugin,
  subscribePluginRuntime,
  uninstallPlugin,
  type PluginSettingContribution,
} from '../lib/plugins';

type CoreSection = 'vault' | 'git' | 'api' | 'sharing' | 'plugins' | 'appearance' | 'account' | 'about';
type Section = CoreSection | `plugin:${string}`;

export default function Settings({
  theme,
  onThemeChange,
}: {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => Promise<void>;
}) {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('vault');
  const [settings, setSettings] = useState<any>(null);
  const [settingsQuery, setSettingsQuery] = useState('');
  const pluginRuntime = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginRuntimeSnapshot,
    getPluginRuntimeSnapshot,
  );

  useEffect(() => {
    if (open) api.getSettings().then(setSettings).catch(() => {});
  }, [open]);

  if (!open) return null;

  const coreSections = (['vault', 'git', 'api', 'sharing', 'appearance', 'account', 'about'] as CoreSection[])
    .filter((item) => labels[item].toLowerCase().includes(settingsQuery.trim().toLowerCase()));
  const pluginTabs = pluginRuntime.settingTabs.filter((tab) =>
    tab.name.toLowerCase().includes(settingsQuery.trim().toLowerCase()),
  );

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-titlebar">
          <span>Settings</span>
          <button aria-label="Close settings" onClick={() => setOpen(false)}><Icon name="x" size={17} /></button>
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            <div className="settings-search"><Icon name="search" size={15} /><input placeholder="Search settings…" value={settingsQuery} onChange={(event) => setSettingsQuery(event.target.value)} /></div>
            <div className="settings-nav-group">Options</div>
            {coreSections.map((s) => (
              <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                {labels[s]}
              </button>
            ))}
            {labels.plugins.toLowerCase().includes(settingsQuery.trim().toLowerCase()) && (
              <button className={section === 'plugins' ? 'active' : ''} onClick={() => setSection('plugins')}>
                {labels.plugins}
              </button>
            )}
            {pluginTabs.length > 0 && <div className="settings-nav-group plugin-group">Plugin options</div>}
            {pluginTabs.map((tab) => (
              <button
                key={tab.id}
                className={section === `plugin:${tab.id}` ? 'active' : ''}
                onClick={() => setSection(`plugin:${tab.id}`)}
              >
                {tab.name}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {settings && section === 'vault' && <VaultSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {settings && section === 'git' && <GitSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'api' && <ApiKeys />}
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins onOpenSettings={(pluginId) => {
              const tab = pluginRuntime.settingTabs.find((item) => item.pluginId === pluginId);
              if (tab) setSection(`plugin:${tab.id}`);
            }} />}
            {settings && section === 'appearance' && <Appearance theme={theme} onThemeChange={onThemeChange} />}
            {section === 'account' && <AccountSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'about' && <About />}
            {section.startsWith('plugin:') && (
              <PluginSettingsPanel tab={pluginRuntime.settingTabs.find((tab) => `plugin:${tab.id}` === section)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const labels: Record<CoreSection, string> = {
  vault: 'Vault & Files',
  git: 'GitHub Sync',
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  account: 'Account',
  about: 'About',
};

export function PluginSettingsPanel({ tab }: { tab?: PluginSettingContribution }) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    if (!tab) return;
    let active = true;
    const reportError = (reason: unknown) => {
      if (!active) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(`[plugin:${tab.pluginId}] Settings tab failed`, reason);
      setError(message || 'Unknown plugin settings error');
    };

    setError('');
    tab.tab.containerEl.replaceChildren();
    try {
      const result = (tab.tab.display as () => unknown)();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result).catch(reportError);
      }
    } catch (reason) {
      reportError(reason);
    }

    return () => {
      active = false;
      try { tab.tab.hide(); }
      catch (reason) { console.error(`[plugin:${tab.pluginId}] Settings tab cleanup failed`, reason); }
    };
  }, [attempt, tab]);
  if (!tab) return <div>Plugin settings are no longer available.</div>;
  return (
    <div className="plugin-settings-panel">
      <h2>{tab.name}</h2>
      {error && (
        <div className="plugin-settings-error" role="alert">
          <strong>Could not render this plugin's settings.</strong>
          <span>{error}</span>
          <button className="btn secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      )}
      <PluginDomMount el={tab.tab.containerEl} className="plugin-settings-host" />
    </div>
  );
}

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function VaultSettings({ s, reload }: { s: any; reload: () => void }) {
  const [path, setPath] = useState(s.vault.path);
  const [deleteMode, setDeleteMode] = useState(s.vault.deleteMode ?? 'trash');
  const [browser, setBrowser] = useState<any>(null);
  const save = async () => {
    await api.putSettings({ vault: { path } });
    await reload();
    alert('Vault path saved. Reindex from the command palette if needed.');
  };
  const saveDeleteMode = async (mode: string) => {
    setDeleteMode(mode);
    await api.putSettings({ vault: { deleteMode: mode } });
    await reload();
  };
  const browse = async (dir?: string) => setBrowser(await api.browse(dir).catch((e) => ({ error: e.message })));
  return (
    <div>
      <h2>Vault & Files</h2>
      <Row name="Vault path" desc="Absolute path on the server to your notes folder">
        <input className="text-input" style={{ width: 260 }} value={path} onChange={(e) => setPath(e.target.value)} />
      </Row>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button className="btn secondary" onClick={() => browse()}>Browse…</button>
        <button className="btn" onClick={save}>Save vault path</button>
      </div>
      {browser && !browser.error && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{browser.dir}</div>
          <div className="result" onClick={() => browse(browser.parent)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="folder" size={15} /> ..
          </div>
          {browser.folders.map((f: any) => (
            <div className="result" key={f.path} onClick={() => browse(f.path)} onDoubleClick={() => setPath(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="folder" size={15} /> {f.name}
              <button className="btn secondary" style={{ float: 'right', padding: '2px 8px' }} onClick={(e) => { e.stopPropagation(); setPath(f.path); }}>
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      {browser?.error && <div style={{ color: '#e5534b' }}>{browser.error}</div>}
      <Row
        name="When deleting a file"
        desc="Move to .trash keeps a recoverable copy (Open trash to restore). Permanently delete removes it immediately."
      >
        <select
          className="text-input"
          style={{ width: 220 }}
          value={deleteMode}
          onChange={(e) => saveDeleteMode(e.target.value)}
        >
          <option value="trash">Move to .trash (recoverable)</option>
          <option value="permanent">Permanently delete</option>
        </select>
      </Row>
    </div>
  );
}

function GitSettings({ s, reload }: { s: any; reload: () => void }) {
  const [g, setG] = useState({ ...s.git });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const set = (k: string, v: any) => setG((p: any) => ({ ...p, [k]: v }));
  // Append timestamped lines to the running log instead of replacing it, so the
  // textarea keeps a history of every git action across clicks.
  const append = (lines: string[]) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, ...lines.map((l, i) => (i === 0 ? `[${ts}] ${l}` : `         ${l}`))]);
  };
  // Auto-scroll to the newest line whenever the log grows.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  const save = async () => { await api.putSettings({ git: g }); await reload(); append(['Saved git settings']); };
  const run = async (fn: () => Promise<any>, label: string) => {
    append([`${label}…`]);
    try {
      const r = await fn();
      // sync returns { ok, log: string[] }; others return { message }. Split any
      // embedded newlines so multi-line git output renders one line per row.
      const lines: string[] = Array.isArray(r?.log)
        ? [`${label} ${r.ok ? 'ok' : 'NOT ok'}`, ...r.log]
        : [String(r?.message ?? JSON.stringify(r))];
      append(lines.flatMap((l) => String(l).split('\n')));
    } catch (e: any) { append([`Error: ${e.message}`]); }
  };
  return (
    <div>
      <h2>GitHub Sync</h2>
      <Row name="Enable git sync"><input type="checkbox" checked={g.enabled} onChange={(e) => set('enabled', e.target.checked)} /></Row>
      <Row name="Remote URL" desc="https://github.com/owner/repo.git">
        <input className="text-input" style={{ width: 260 }} value={g.remote} onChange={(e) => set('remote', e.target.value)} />
      </Row>
      <Row name="Branch"><input className="text-input" style={{ width: 120 }} value={g.branch} onChange={(e) => set('branch', e.target.value)} /></Row>
      <Row name="Access token (PAT)" desc="Stored server-side; leave masked to keep current">
        <input className="text-input" type="password" style={{ width: 260 }} value={g.token} onChange={(e) => set('token', e.target.value)} />
      </Row>
      <Row name="Author name"><input className="text-input" value={g.authorName} onChange={(e) => set('authorName', e.target.value)} /></Row>
      <Row name="Author email"><input className="text-input" value={g.authorEmail} onChange={(e) => set('authorEmail', e.target.value)} /></Row>
      <Row name="Auto-sync" desc="Periodic pull+commit+push on the interval below"><input type="checkbox" checked={g.autoSync} onChange={(e) => set('autoSync', e.target.checked)} /></Row>
      <Row name="Auto-commit on save" desc="Commit (+push) ~5s after each edit"><input type="checkbox" checked={g.autoCommitOnSave} onChange={(e) => set('autoCommitOnSave', e.target.checked)} /></Row>
      <Row name="Interval (sec)"><input className="text-input" type="number" style={{ width: 90 }} value={g.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} /></Row>
      <Row name="Git LFS patterns" desc="Space-separated globs tracked via LFS">
        <input className="text-input" style={{ width: 260 }} value={(g.lfsPatterns || []).join(' ')} onChange={(e) => set('lfsPatterns', e.target.value.split(/\s+/).filter(Boolean))} />
      </Row>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" onClick={() => run(api.gitInit, 'Init')}>Init repo</button>
        <button className="btn secondary" onClick={() => run(api.gitClone, 'Clone')}>Clone</button>
        <button className="btn secondary" onClick={() => run(api.gitPull, 'Pull')}>Pull</button>
        <button className="btn secondary" onClick={() => run(() => api.gitCommit(), 'Commit')}>Commit</button>
        <button className="btn secondary" onClick={() => run(api.gitPush, 'Push')}>Push</button>
        <button className="btn" onClick={() => run(() => api.gitSync(), 'Sync')}>Sync now</button>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sync log</span>
          {log.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setLog([])}>Clear</button>
          )}
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={log.length ? log.join('\n') : 'No git activity yet. Click an action above (Sync now, Pull, Push…) to see logs here.'}
          style={{
            width: '100%', height: 200, boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--bg-primary)', color: 'var(--text-normal)',
            border: '1px solid var(--bg-modifier-border, #444)', borderRadius: 6, padding: 10,
            fontFamily: 'var(--font-monospace, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre',
          }}
        />
      </div>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('my-agent');
  const [scopes, setScopes] = useState<string[]>(['read', 'search']);
  const [created, setCreated] = useState('');
  const load = () => api.listKeys().then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = (sc: string) => setScopes((p) => (p.includes(sc) ? p.filter((x) => x !== sc) : [...p, sc]));
  const create = async () => {
    const r = await api.createKey(name, scopes);
    setCreated(r.key);
    await load();
  };
  return (
    <div>
      <h2>API Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys let AI agents call <code>/api/v1</code>. The raw key is shown once.</p>
      <Row name="Name"><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
      <Row name="Scopes">
        <span>
          {['read', 'write', 'search'].map((sc) => (
            <label key={sc} style={{ marginRight: 10 }}>
              <input type="checkbox" checked={scopes.includes(sc)} onChange={() => toggle(sc)} /> {sc}
            </label>
          ))}
        </span>
      </Row>
      <button className="btn" onClick={create}>Create key</button>
      {created && (
        <pre style={{ background: 'var(--bg-primary)', padding: 10, borderRadius: 6, marginTop: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {created}
          {'\n'}⚠ Copy now — it will not be shown again.
        </pre>
      )}
      <div style={{ marginTop: 16 }}>
        {keys.map((k) => (
          <div className="setting-row" key={k.id}>
            <div className="info">
              <div className="name">{k.name} <span style={{ color: 'var(--text-faint)' }}>{k.prefix}…</span></div>
              <div className="desc">scopes: {k.scopes.join(', ')} · used: {k.lastUsed ?? 'never'}</div>
            </div>
            <button className="btn danger" onClick={async () => { await api.revokeKey(k.id); load(); }}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shares() {
  const notify = useStore((s) => s.notify);
  const openFile = useStore((s) => s.openFile);
  const setOpen = useStore((s) => s.setSettings);
  // Shared with the store so the file tree's globe badges refresh on changes.
  const shares = useStore((s) => s.shares);
  const load = useStore((s) => s.loadShares);
  const [query, setQuery] = useState('');
  useEffect(() => { load(); }, [load]);

  const url = (id: string) => `${location.origin}/share/${id}`;
  const copy = (id: string) => {
    navigator.clipboard?.writeText(url(id)).catch(() => {});
    notify('Public link copied');
  };
  const toggle = async (s: any) => {
    await api.setShareEnabled(s.id, !s.enabled);
    load();
  };
  const remove = async (s: any) => {
    if (!confirm(`Delete the public link for "${s.path}"? The URL stops working permanently.`)) return;
    await api.deleteShare(s.id);
    load();
  };
  const setPassword = async (s: any) => {
    const pw = prompt(
      s.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:',
    );
    if (pw === null) return;
    await api.setSharePassword(s.id, pw || null);
    notify(pw ? 'Password set' : 'Password removed');
    load();
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? shares.filter((s) => s.path.toLowerCase().includes(q)) : shares;

  return (
    <div>
      <h2>Sharing</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Notes shared via a public link are readable by <b>anyone with the URL</b>, without login.
        Create a link from a note's context menu ("Share…"). Disable keeps the URL for
        re-enabling later; delete revokes it permanently.
      </p>
      <input
        className="text-input"
        style={{ width: '100%', margin: '6px 0 12px' }}
        placeholder="Search shared notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 && (
        <div style={{ color: 'var(--text-faint)' }}>
          {shares.length === 0 ? 'No notes are shared publicly.' : 'No shared note matches the search.'}
        </div>
      )}
      {filtered.map((s) => (
        <div className="setting-row" key={s.id}>
          <div className="info" style={{ minWidth: 0 }}>
            <div
              className="name"
              style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: s.enabled ? 1 : 0.55 }}
              title={`Open ${s.path}`}
              onClick={() => { openFile(s.path); setOpen(false); }}
            >
              {s.path}
            </div>
            <div className="desc">
              {s.enabled ? 'active' : 'disabled'}
              {s.hasPassword ? ' · password-protected' : ''} · created {new Date(s.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn secondary" disabled={!s.enabled} onClick={() => copy(s.id)} title={url(s.id)}>
              <Icon name="link" size={14} /> Copy link
            </button>
            <button className="btn secondary" onClick={() => setPassword(s)} title={s.hasPassword ? 'Change or remove password' : 'Require a password to open the link'}>
              {s.hasPassword ? 'Password ✓' : 'Password…'}
            </button>
            <button className={`btn ${s.enabled ? 'secondary' : ''}`} onClick={() => toggle(s)}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn danger" onClick={() => remove(s)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Plugins({ onOpenSettings }: { onOpenSettings: (pluginId: string) => void }) {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);
  const [menuPlugin, setMenuPlugin] = useState<string | null>(null);
  const [details, setDetails] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [autoUpdates, setAutoUpdates] = useState(() => localStorage.getItem('webobsidian:plugin-auto-updates') !== 'false');
  const runtime = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginRuntimeSnapshot,
    getPluginRuntimeSnapshot,
  );
  const load = () => api.listPlugins().then((r) => setPlugins(r.plugins)).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = async (plugin: any, enabled: boolean) => {
    setMsg(`${enabled ? 'Enabling' : 'Disabling'} ${plugin.name}…`);
    try {
      const reloading = enabled
        ? await enablePlugin(plugin.id)
        : await disablePlugin(plugin.id);
      if (reloading) {
        setMsg(`Reloading to apply plugin security policy…`);
        return;
      }
      await load();
      setMsg(`${plugin.name} ${enabled ? 'enabled' : 'disabled'} ✓`);
    } catch (error: any) {
      setMsg(`Error: ${error.message}`);
      await load();
    }
  };
  const uninstall = async (plugin: any) => {
    setMenuPlugin(null);
    if (!confirm(`Uninstall "${plugin.name}"? Plugin settings stored in its folder will also be removed.`)) return;
    setMsg(`Uninstalling ${plugin.name}…`);
    try {
      // One atomic server call: it removes the plugin from `enabled` and
      // `installed` and deletes the folder. Disabling first would leave the
      // plugin disabled-but-installed if the uninstall call then failed.
      const reloading = await uninstallPlugin(plugin.id);
      if (reloading) {
        setMsg('Reloading to apply plugin security policy…');
        return;
      }
      await load();
      setMsg(`${plugin.name} uninstalled`);
    } catch (error: any) {
      await load();
      setMsg(`Error: could not uninstall ${plugin.name} — ${error.message || 'request failed'}`);
    }
  };
  const filtered = plugins.filter((plugin) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${plugin.name} ${plugin.description ?? ''} ${plugin.author ?? ''}`.toLowerCase().includes(needle);
  });
  return (
    <div className="community-settings">
      <div className="settings-card">
        <Row name="Restricted mode" desc="Turn on Restricted mode to use the app without community plugins.">
          <button className="btn secondary" disabled={!plugins.some((plugin) => plugin.enabled)} onClick={async () => {
            setMsg('Disabling community plugins…');
            for (const plugin of plugins.filter((item) => item.enabled)) await disablePlugin(plugin.id);
            location.reload();
          }}>Turn on and reload</button>
        </Row>
        <Row name="Community plugins" desc="Browse and install community plugins made by the community.">
          <button className="btn secondary" onClick={() => setBrowseOpen(true)}>Browse</button>
        </Row>
        <Row name="Current plugins" desc={`You currently have ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} installed.`}>
          <button className="btn secondary" onClick={() => setMsg('All installed plugins are up to date.')}>Check for updates</button>
        </Row>
        <Row name="Automatically check for plugin updates" desc="Periodically check for plugin updates.">
          <Switch value={autoUpdates} onChange={(value) => { setAutoUpdates(value); localStorage.setItem('webobsidian:plugin-auto-updates', String(value)); }} label="Automatically check for updates" />
        </Row>
      </div>

      <div className="installed-heading">
        <h2>Installed plugins</h2>
        <span>{plugins.length}</span>
      </div>
      <div className="installed-plugin-card">
        <div className="installed-search"><Icon name="search" size={16} /><input placeholder="Search installed plugins…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        {msg && <div className="plugin-message">{msg}</div>}
        {filtered.length === 0 && <div className="plugin-empty">{plugins.length ? 'No installed plugin matches your search.' : 'No plugins installed yet. Select Browse to explore community plugins.'}</div>}
        {filtered.map((plugin) => (
          <div className="installed-plugin" key={plugin.id}>
            <div className="installed-plugin-info">
              <div className="installed-plugin-title">{plugin.name} <span>v{plugin.version}</span>{plugin.author && <small> By {plugin.author}</small>}</div>
              <div className="installed-plugin-description">{plugin.description}</div>
              <PluginStatus state={runtime.plugins[plugin.id]} desktopOnly={plugin.isDesktopOnly} />
            </div>
            <div className="installed-plugin-actions">
              <div className="plugin-menu-wrap">
                <button className="icon-button" aria-label={`More options for ${plugin.name}`} onClick={() => setMenuPlugin(menuPlugin === plugin.id ? null : plugin.id)}><Icon name="more-horizontal" size={18} /></button>
                {menuPlugin === plugin.id && (
                  <div className="plugin-dropdown">
                    <button disabled={!runtime.settingTabs.some((tab) => tab.pluginId === plugin.id)} onClick={() => { setMenuPlugin(null); onOpenSettings(plugin.id); }}><Icon name="settings" size={15} />Settings</button>
                    <button disabled={!plugin.enabled || plugin.isDesktopOnly} onClick={async () => { setMenuPlugin(null); await reloadPlugin(plugin.id); setMsg(`${plugin.name} reloaded ✓`); }}><Icon name="refresh-cw" size={15} />Reload</button>
                    <button onClick={() => { setMenuPlugin(null); setDetails(plugin); }}><Icon name="info" size={15} />View details</button>
                    <a href={plugin.authorUrl || `https://obsidian.md/plugins?id=${encodeURIComponent(plugin.id)}`} target="_blank" rel="noreferrer"><Icon name="globe" size={15} />Open community page</a>
                    <div className="plugin-dropdown-separator" />
                    <button className="danger" onClick={() => void uninstall(plugin)}><Icon name="trash" size={15} />Uninstall</button>
                  </div>
                )}
              </div>
              <Switch value={plugin.enabled} disabled={runtime.plugins[plugin.id]?.status === 'loading' || (!plugin.enabled && plugin.isDesktopOnly)} onChange={(enabled) => void toggle(plugin, enabled)} label={`Enable ${plugin.name}`} />
            </div>
          </div>
        ))}
      </div>
      <p className="plugin-trust-note">Community plugins run as trusted code with access to your vault. Plugins requiring Electron or Node.js are not compatible with the web app.</p>
      {browseOpen && <PluginBrowser installed={plugins} onClose={() => { setBrowseOpen(false); load(); }} />}
      {details && <PluginDetails plugin={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

function Switch({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={value} disabled={disabled} className={`settings-switch${value ? ' on' : ''}`} onClick={() => onChange(!value)}><span /></button>;
}

function PluginBrowser({ installed, onClose }: { installed: any[]; onClose: () => void }) {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [sort, setSort] = useState<'downloads' | 'updated' | 'name'>('downloads');
  const [details, setDetails] = useState<any | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedIds, setInstalledIds] = useState(() => new Set(installed.map((plugin) => plugin.id)));
  const loadCatalog = () => {
    setLoading(true);
    setError('');
    api.listCommunityPlugins()
      .then((result) => setCatalog(result.plugins))
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    loadCatalog();
  }, []);
  const needle = query.trim().toLowerCase();
  const filtered = catalog
    .filter((plugin) => (!installedOnly || installedIds.has(plugin.id)) && (!needle || `${plugin.name} ${plugin.description ?? ''} ${plugin.author ?? ''}`.toLowerCase().includes(needle)))
    .sort((left, right) => {
      if (sort === 'updated') return (right.updated ?? 0) - (left.updated ?? 0) || right.downloads - left.downloads;
      if (sort === 'name') return left.name.localeCompare(right.name);
      return right.downloads - left.downloads || left.name.localeCompare(right.name);
    });
  useEffect(() => setVisibleCount(100), [query, installedOnly, sort]);
  const visible = filtered.slice(0, visibleCount);
  const install = async (plugin: any) => {
    setInstalling(plugin.id);
    setError('');
    try {
      await api.installPlugin(plugin.repo);
      setInstalledIds((current) => new Set(current).add(plugin.id));
    } catch (reason: any) { setError(reason.message); }
    finally { setInstalling(null); }
  };
  return (
    <div className="plugin-browser-backdrop" onClick={onClose}>
      <div className="plugin-browser" onClick={(event) => event.stopPropagation()}>
        <div className="plugin-browser-titlebar"><strong>Community plugins</strong><button className="icon-button" onClick={onClose} aria-label="Close community plugins"><Icon name="x" size={18} /></button></div>
        <div className="plugin-browser-toolbar">
          <div className="community-search"><Icon name="search" size={17} /><input autoFocus placeholder="Search community plugins…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="plugin-browser-filters">
            <label className="installed-only"><span>Show installed only</span><Switch value={installedOnly} onChange={setInstalledOnly} label="Show installed only" /></label>
            <label className="plugin-sort"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="downloads">Most downloaded</option><option value="updated">Recently updated</option><option value="name">Name</option></select></label>
          </div>
          <div className="community-count">{loading ? 'Loading plugins…' : `${filtered.length.toLocaleString()} plugins found · showing ${Math.min(visible.length, filtered.length).toLocaleString()}`}</div>
        </div>
        {error && <div className="plugin-browser-error"><span>{error}</span><button className="btn secondary" onClick={loadCatalog}>Try again</button></div>}
        <div className="plugin-grid">
          {visible.map((plugin) => (
            <article className="plugin-card" key={plugin.id} role="button" tabIndex={0} onClick={() => setDetails(plugin)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDetails(plugin); } }}>
              <div className="plugin-card-title"><strong>{plugin.name}</strong>{installedIds.has(plugin.id) && <span>INSTALLED</span>}</div>
              {plugin.author && <div className="plugin-card-author">By {plugin.author}</div>}
              <p>{plugin.description || 'No description provided.'}</p>
              <div className="plugin-card-stats"><span><Icon name="download" size={13} />{formatDownloads(plugin.downloads)}</span>{plugin.updated && <span>Updated {formatPluginDate(plugin.updated)}</span>}</div>
              <div className="plugin-card-footer">
                <button className="plugin-details-link" onClick={(event) => { event.stopPropagation(); setDetails(plugin); }}>View details</button>
                {!installedIds.has(plugin.id) && <button className="btn" disabled={installing !== null} onClick={(event) => { event.stopPropagation(); void install(plugin); }}>{installing === plugin.id ? 'Installing…' : 'Install'}</button>}
              </div>
            </article>
          ))}
          {visible.length < filtered.length && <button className="btn secondary plugin-load-more" onClick={() => setVisibleCount((count) => count + 100)}>Load 100 more</button>}
          {!loading && !error && !filtered.length && <div className="plugin-empty">No community plugin matches your search.</div>}
        </div>
        {details && <PluginDetails plugin={details} installed={installedIds.has(details.id)} installing={installing === details.id} onInstall={() => void install(details)} onClose={() => setDetails(null)} />}
      </div>
    </div>
  );
}

function formatDownloads(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatPluginDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function PluginDetails({ plugin, installed = false, installing = false, onInstall, onClose }: { plugin: any; installed?: boolean; installing?: boolean; onInstall?: () => void; onClose: () => void }) {
  const [readmeHtml, setReadmeHtml] = useState('');
  const [readmeSource, setReadmeSource] = useState('');
  const [readmeRepo, setReadmeRepo] = useState(plugin.repo ?? '');
  const [readmeLoading, setReadmeLoading] = useState(Boolean(plugin.id));
  const [readmeError, setReadmeError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!plugin.id) {
      setReadmeLoading(false);
      return;
    }
    setReadmeLoading(true);
    setReadmeError('');
    api.getCommunityPluginReadme(plugin.id, plugin.repo)
      .then(async ({ readme }) => {
        if (cancelled) return;
        setReadmeRepo(readme.repo);
        setReadmeSource(readme.sourceUrl);
        if (!readme.markdown) {
          setReadmeHtml('');
          return;
        }
        const markdown = rewriteGithubReadmeUrls(readme.markdown, readme.assetBaseUrl, readme.repo);
        const html = await renderMarkdown(markdown, {
          rawUrl: (relative) => new URL(relative, readme.assetBaseUrl).href,
        });
        if (!cancelled) setReadmeHtml(html);
      })
      .catch((error) => { if (!cancelled) setReadmeError(error.message); })
      .finally(() => { if (!cancelled) setReadmeLoading(false); });
    return () => { cancelled = true; };
  }, [plugin.id]);

  const openReadmeLink = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link?.href) return;
    event.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  };
  return (
    <div className="plugin-browser-backdrop" onClick={onClose}>
      <div className="plugin-details" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button plugin-details-close" onClick={onClose}><Icon name="x" size={18} /></button>
        <h2>{plugin.name}</h2>
        <div className="plugin-detail-meta">{plugin.version ? `Version ${plugin.version} · ` : ''}{plugin.author ? `By ${plugin.author}` : 'Community plugin'}</div>
        {typeof plugin.downloads === 'number' && <div className="plugin-detail-stats"><span><Icon name="download" size={15} />{plugin.downloads.toLocaleString()} downloads</span>{plugin.updated && <span>Updated {formatPluginDate(plugin.updated)}</span>}</div>}
        <p>{plugin.description || 'No description provided.'}</p>
        <div className="plugin-detail-id">Plugin ID: <code>{plugin.id}</code></div>
        {readmeRepo && <div className="plugin-detail-repo">Repository: <a href={`https://github.com/${readmeRepo}`} target="_blank" rel="noreferrer">{readmeRepo}</a></div>}
        {onInstall && <div className="plugin-detail-actions">{installed ? <span className="plugin-installed-badge">Installed</span> : <button className="btn" disabled={installing} onClick={onInstall}>{installing ? 'Installing…' : 'Install'}</button>}</div>}
        <div className="plugin-readme-heading"><strong>README</strong>{readmeSource && <a href={readmeSource} target="_blank" rel="noreferrer">View on GitHub</a>}</div>
        <div className="plugin-readme markdown-preview">
          {readmeLoading && <div className="plugin-readme-state">Loading README…</div>}
          {readmeError && <div className="plugin-readme-state error">Could not load README: {readmeError}</div>}
          {!readmeLoading && !readmeError && !readmeHtml && <div className="plugin-readme-state">This plugin does not provide a README.md file.</div>}
          {readmeHtml && <div className="preview-inner" onClick={openReadmeLink} dangerouslySetInnerHTML={{ __html: readmeHtml }} />}
        </div>
      </div>
    </div>
  );
}

function rewriteGithubReadmeUrls(markdown: string, assetBaseUrl: string, repo: string): string {
  const isAbsolute = (target: string) => /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
  const resolve = (target: string, image: boolean) => {
    const clean = target.replace(/^<|>$/g, '');
    if (!clean || isAbsolute(clean)) return target;
    if (image) return new URL(clean, assetBaseUrl).href;
    const relative = new URL(clean, assetBaseUrl).pathname.split('/HEAD/')[1] ?? clean;
    return `https://github.com/${repo}/blob/HEAD/${relative}`;
  };
  return markdown
    .replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^\s)]+)([^)]*\))/g, (_match, prefix: string, target: string, suffix: string) => `${prefix}${resolve(target, prefix.startsWith('!'))}${suffix}`)
    .replace(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi, (_match, prefix: string, target: string, suffix: string) => `${prefix}${resolve(target, true)}${suffix}`)
    .replace(/(<a\b[^>]*?\bhref=["'])([^"']+)(["'])/gi, (_match, prefix: string, target: string, suffix: string) => `${prefix}${resolve(target, false)}${suffix}`);
}

function PluginStatus({ state, desktopOnly }: { state?: any; desktopOnly?: boolean }) {
  const status = desktopOnly ? 'incompatible' : state?.status ?? 'disabled';
  const colors: Record<string, string> = {
    loaded: '#46a758', loading: '#d19a00', failed: '#e5534b', incompatible: '#e5534b', disabled: 'var(--text-faint)',
  };
  const labels: Record<string, string> = {
    loaded: 'Loaded', loading: 'Loading…', failed: 'Load failed', incompatible: 'Not compatible', disabled: 'Disabled',
  };
  return (
    <div className="plugin-runtime-status" style={{ color: colors[status], fontSize: 12, marginTop: 5 }}>
      {labels[status] ?? status}{state?.message ? ` — ${state.message}` : ''}
    </div>
  );
}

function Appearance({
  theme,
  onThemeChange,
}: {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => Promise<void>;
}) {
  return (
    <div>
      <h2>Appearance</h2>
      <Row name="Theme">
        <select
          className="text-input"
          value={theme}
          onChange={(event) => void onThemeChange(event.target.value as ThemeSetting)}
        >
          <option value="obsidian-dark">Obsidian Dark</option>
          <option value="obsidian-light">Obsidian Light</option>
        </select>
      </Row>
    </div>
  );
}

function AccountSettings({ s: _s, reload }: { s: any; reload: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [securityPassword, setSecurityPassword] = useState('');
  const [factorCode, setFactorCode] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [totpSetup, setTotpSetup] = useState<{
    setupId: string;
    secret: string;
    uri: string;
    qr: string;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [securityBusy, setSecurityBusy] = useState('');
  const [securityErr, setSecurityErr] = useState('');
  const [securityMsg, setSecurityMsg] = useState('');

  const loadSecurity = async () => setSecurity(await api.securityStatus());

  useEffect(() => {
    loadSecurity().catch(() => {});
  }, []);

  const save = async () => {
    setErr('');
    setMsg('');
    if (next.length < 12) {
      setErr('Mật khẩu mới phải có ít nhất 12 ký tự');
      return;
    }
    if (next !== confirm) {
      setErr('Mật khẩu xác nhận không khớp');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setMsg('Đã đổi mật khẩu ✓');
      setCurrent('');
      setNext('');
      setConfirm('');
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? 'Đổi mật khẩu thất bại');
    } finally {
      setBusy(false);
    }
  };

  const securityAction = async (name: string, action: () => Promise<void>) => {
    setSecurityErr('');
    setSecurityMsg('');
    setSecurityBusy(name);
    try {
      await action();
      await loadSecurity();
    } catch (e: any) {
      setSecurityErr(e?.message ?? 'Security update failed');
    } finally {
      setSecurityBusy('');
    }
  };

  const requireSecurityPassword = (): boolean => {
    if (securityPassword) return true;
    setSecurityErr('Enter your current password first.');
    setSecurityMsg('');
    return false;
  };

  const startTotp = () => {
    if (!requireSecurityPassword()) return;
    void securityAction('totp-start', async () => {
      const setup = await api.startTotpSetup(securityPassword);
      const qr = await QRCode.toDataURL(setup.uri, { width: 220, margin: 1 });
      setTotpSetup({ ...setup, qr });
      setFactorCode('');
      setRecoveryCodes([]);
    });
  };

  const verifyTotp = () => securityAction('totp-verify', async () => {
    if (!totpSetup) return;
    const result = await api.verifyTotpSetup(totpSetup.setupId, factorCode);
    setRecoveryCodes(result.recoveryCodes);
    setTotpSetup(null);
    setFactorCode('');
    setSecurityMsg('Authenticator 2FA enabled. Save the recovery codes now.');
  });

  const turnOffTotp = () => securityAction('totp-disable', async () => {
    if (!window.confirm('Disable authenticator 2FA?')) return;
    await api.disableTotp(securityPassword, factorCode);
    setFactorCode('');
    setRecoveryCodes([]);
    setSecurityMsg('Authenticator 2FA disabled.');
  });

  const newRecoveryCodes = () => securityAction('recovery', async () => {
    const result = await api.regenerateRecoveryCodes(securityPassword, factorCode);
    setRecoveryCodes(result.recoveryCodes);
    setFactorCode('');
    setSecurityMsg('New recovery codes generated. Older codes no longer work.');
  });

  const addPasskey = () => {
    if (!requireSecurityPassword()) return;
    const name = passkeyName.trim();
    if (!name) {
      setSecurityErr('Enter a name for this Passkey, for example “MacBook” or “iPhone”.');
      setSecurityMsg('');
      return;
    }
    void securityAction('passkey-add', async () => {
      if (!window.isSecureContext || typeof window.PublicKeyCredential === 'undefined') {
        throw new Error('Passkeys require HTTPS or localhost in a supported browser');
      }
      const { ceremonyId, options } = await api.passkeyRegistrationOptions(
        securityPassword,
        name,
      );
      const response = await startRegistration({ optionsJSON: options });
      await api.passkeyRegistrationVerify(ceremonyId, response);
      setPasskeyName('');
      setSecurityMsg('Passkey added.');
    });
  };

  const removePasskey = (id: string, name: string) => securityAction(`passkey-${id}`, async () => {
    if (!window.confirm(`Remove Passkey “${name}”?`)) return;
    await api.deletePasskey(id, securityPassword);
    setSecurityMsg('Passkey removed. Other active sessions were revoked.');
  });

  const copyRecoveryCodes = async () => {
    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    setSecurityMsg('Recovery codes copied.');
  };

  const downloadRecoveryCodes = () => {
    const blob = new Blob([
      `WebObsidian recovery codes\nGenerated: ${new Date().toISOString()}\n\n${recoveryCodes.join('\n')}\n`,
    ], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'webobsidian-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div>
      <h2>Account</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Mật khẩu đăng nhập vào WebObsidian.
      </p>
      <Row name="Mật khẩu hiện tại">
        <input className="text-input" type="password" style={{ width: 240 }} value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Row>
      <Row name="Mật khẩu mới" desc="Tối thiểu 12 ký tự">
        <input className="text-input" type="password" style={{ width: 240 }} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Row>
      <Row name="Xác nhận mật khẩu mới">
        <input className="text-input" type="password" style={{ width: 240 }} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <button className="btn" onClick={save} disabled={busy || !current || !next}>
        {busy ? 'Đang lưu…' : 'Đổi mật khẩu'}
      </button>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
        Quên mật khẩu? Đặt <code>auth.passwordHash</code> trong <code>data/settings.json</code> hoặc
        biến môi trường <code>WEBOBSIDIAN_PASSWORD</code> làm mật khẩu khôi phục (override) rồi đăng
        nhập lại để đổi mật khẩu mới. Nếu đã bật 2FA, dùng một mã khôi phục; trong trường hợp mất cả
        thiết bị lẫn mã khôi phục, dừng server và đặt <code>auth.totp.enabled</code> thành
        <code>false</code> trong file cấu hình trước khi khởi động lại.
      </p>

      <div className="settings-divider" />
      <h2>Two-factor authentication & Passkeys</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Use an authenticator app as a second step after your password, or sign in passwordlessly
        with a Passkey protected by your device.
      </p>
      <Row
        name="Confirm current password"
        desc="Required before adding or removing a sign-in method"
      >
        <input
          className="text-input"
          type="password"
          style={{ width: 240 }}
          value={securityPassword}
          onChange={(e) => {
            setSecurityPassword(e.target.value);
            if (securityErr) setSecurityErr('');
          }}
          autoComplete="current-password"
        />
      </Row>
      {securityErr && <div className="security-error" role="alert">{securityErr}</div>}
      {securityMsg && <div className="security-success" role="status">{securityMsg}</div>}

      <div className="security-card">
        <div className="security-card-head">
          <div>
            <strong>Authenticator app (TOTP)</strong>
            <div className="security-note">
              {security?.totpEnabled
                ? `Enabled · ${security.recoveryCodesRemaining} recovery codes remaining`
                : 'Not enabled'}
            </div>
          </div>
          {!security?.totpEnabled && !totpSetup && (
            <button
              className="btn"
              onClick={startTotp}
              disabled={Boolean(securityBusy)}
            >
              {securityBusy === 'totp-start' ? 'Starting…' : 'Set up'}
            </button>
          )}
        </div>

        {totpSetup && (
          <div className="totp-setup">
            <p>Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password, or another TOTP app.</p>
            <img src={totpSetup.qr} alt="Authenticator setup QR code" width={220} height={220} />
            <div className="security-note">Manual key</div>
            <code className="totp-secret">{totpSetup.secret}</code>
            <input
              className="text-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Enter the 6-digit code"
              value={factorCode}
              onChange={(e) => setFactorCode(e.target.value)}
            />
            <div className="security-actions">
              <button
                className="btn"
                onClick={verifyTotp}
                disabled={securityBusy === 'totp-verify' || !factorCode.trim()}
              >
                {securityBusy === 'totp-verify' ? 'Verifying…' : 'Verify & enable'}
              </button>
              <button className="btn secondary" onClick={() => setTotpSetup(null)}>Cancel</button>
            </div>
          </div>
        )}

        {security?.totpEnabled && (
          <div className="security-control-block">
            <input
              className="text-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Authenticator or recovery code"
              value={factorCode}
              onChange={(e) => setFactorCode(e.target.value)}
            />
            <div className="security-actions">
              <button
                className="btn secondary"
                onClick={newRecoveryCodes}
                disabled={Boolean(securityBusy) || !securityPassword || !factorCode.trim()}
              >
                Generate new recovery codes
              </button>
              <button
                className="btn danger"
                onClick={turnOffTotp}
                disabled={Boolean(securityBusy) || !securityPassword || !factorCode.trim()}
              >
                Disable 2FA
              </button>
            </div>
          </div>
        )}
      </div>

      {recoveryCodes.length > 0 && (
        <div className="recovery-codes">
          <strong>Save these recovery codes now</strong>
          <p>Each code works once. They will not be shown again.</p>
          <pre>{recoveryCodes.join('\n')}</pre>
          <div className="security-actions">
            <button className="btn secondary" onClick={copyRecoveryCodes}>Copy</button>
            <button className="btn secondary" onClick={downloadRecoveryCodes}>Download</button>
          </div>
        </div>
      )}

      <div className="security-card">
        <div className="security-card-head">
          <div>
            <strong>Passkeys</strong>
            <div className="security-note">
              {security?.passkeys.length
                ? `${security.passkeys.length} registered`
                : 'No Passkeys registered'}
            </div>
          </div>
        </div>
        <div className="passkey-add">
          <input
            className="text-input"
            placeholder="Name, e.g. MacBook or iPhone"
            maxLength={64}
            value={passkeyName}
            onChange={(e) => {
              setPasskeyName(e.target.value);
              if (securityErr) setSecurityErr('');
            }}
          />
          <button
            className="btn"
            onClick={addPasskey}
            disabled={Boolean(securityBusy)}
          >
            {securityBusy === 'passkey-add' ? 'Waiting for device…' : 'Add Passkey'}
          </button>
        </div>
        {security?.passkeys.map((passkey) => (
          <div className="passkey-row" key={passkey.id}>
            <div>
              <strong>{passkey.name}</strong>
              <div className="security-note">
                Added {new Date(passkey.createdAt).toLocaleDateString()}
                {passkey.lastUsedAt
                  ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
                  : ' · Never used'}
                {passkey.backedUp ? ' · Synced' : ''}
              </div>
            </div>
            <button
              className="btn danger"
              onClick={() => removePasskey(passkey.id, passkey.name)}
              disabled={Boolean(securityBusy) || !securityPassword}
            >
              Remove
            </button>
          </div>
        ))}
        <p className="security-note">
          Passkeys require HTTPS on your domain. HTTP works only on localhost.
        </p>
      </div>

    </div>
  );
}

function About() {
  const logout = async () => { await api.logout(); location.reload(); };
  return (
    <div>
      <h2>About WebObsidian</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        A self-hosted, Obsidian-compatible web app. Vault, QMD search, GitHub sync (with LFS),
        agent API and community plugins.
      </p>
      <button className="btn danger" onClick={logout}>Log out</button>
    </div>
  );
}
