// @vitest-environment happy-dom

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginSettingsPanel } from '../components/Settings';
import {
  ConfirmationModal,
  getPluginApp,
  getPluginRuntimeSnapshot,
  initializePluginRuntime,
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  WorkspaceLeaf,
} from './plugins';
import { useStore } from './store';

const bundleDir = process.env.PLUGIN_BUNDLE_DIR ?? '/tmp/webobsidian-plugin-audit.RaAYbg';
const realBundlesAvailable = existsSync(bundleDir);
const tasksBundlePath = process.env.TASKS_BUNDLE_PATH;
const calendarBundlePath = process.env.CALENDAR_BUNDLE_PATH;
const templaterBundlePath = process.env.TEMPLATER_BUNDLE_PATH;

function runtimeRequire(pluginId: string, moduleName: string): any {
  return globalThis.__webObsidianRequire(pluginId, moduleName);
}

function mockApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (/\/api\/plugins\/[^/]+\/data/.test(url)) {
    return Promise.resolve(Response.json(method === 'GET' ? { data: {} } : { ok: true }));
  }
  if (url.includes('/api/files/tree')) {
    return Promise.resolve(Response.json({ name: 'Test vault', path: '', type: 'folder', children: [] }));
  }
  if (url.includes('/api/files/content')) {
    return Promise.resolve(Response.json(method === 'GET' ? { content: '' } : { ok: true }));
  }
  if (url.includes('/api/search')) return Promise.resolve(Response.json({ results: [] }));
  return Promise.resolve(Response.json({ ok: true, plugins: [] }));
}

initializePluginRuntime();
vi.stubGlobal('fetch', vi.fn(mockApiFetch));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('community plugin compatibility runtime', () => {
  it('exports the API classes and helpers used by current browser-compatible plugins', () => {
    const obsidian = runtimeRequire('fixture', 'obsidian');
    const classNames = [
      'AbstractInputSuggest', 'BaseComponent', 'EditorSuggest', 'FileSystemAdapter',
      'ConfirmationButton', 'ConfirmationModal', 'SettingGroup', 'SettingPage', 'WorkspaceSplit',
    ];
    const helperNames = [
      'arrayBufferToBase64', 'base64ToArrayBuffer', 'getIconIds', 'getLanguage',
      'htmlToMarkdown', 'loadPdfJs', 'parseFrontMatterEntry', 'prepareFuzzySearch',
      'prepareSimpleSearch', 'renderMatches',
    ];
    classNames.forEach((name) => expect(typeof obsidian[name], name).toBe('function'));
    helperNames.forEach((name) => expect(typeof obsidian[name], name).toBe('function'));
    expect(obsidian.__esModule).toBe(true);
    const interopImport = obsidian && obsidian.__esModule ? obsidian : { default: obsidian };
    expect(interopImport.Plugin).toBe(Plugin);
    expect(obsidian.apiVersion).toBe('1.13.1');
    expect(() => obsidian.DefinitelyMissing).toThrow(/unsupported Obsidian API/);
  });

  it('implements Obsidian 1.13 confirmation modal controls', async () => {
    const modal = new ConfirmationModal(getPluginApp()).setTitle('Confirm risky action');
    let confirmed = false;
    let confirmButton = document.createElement('button');

    modal
      .addClass('fixture-confirmation-modal')
      .addCheckbox('I understand', (checked) => { confirmButton!.disabled = !checked; })
      .addButton((button) => {
        confirmButton = button.buttonEl;
        button
          .setButtonText('Enable')
          .setCta()
          .setDisabled(true)
          .setInitialFocus()
          .onClick(async () => { confirmed = true; });
      })
      .addCancelButton();

    modal.open();
    expect(modal.modalEl.classList.contains('fixture-confirmation-modal')).toBe(true);
    expect(confirmButton.disabled).toBe(true);

    const checkbox = modal.buttonContainerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.click();
    expect(confirmButton.disabled).toBe(false);
    confirmButton.click();

    await vi.waitFor(() => expect(confirmed).toBe(true));
    await vi.waitFor(() => expect(modal.containerEl.isConnected).toBe(false));
  });

  it('renders searchable plugin modals inside the active theme with Obsidian selection behavior', async () => {
    const themeRoot = document.createElement('div');
    themeRoot.className = 'theme-dark';
    document.body.appendChild(themeRoot);
    let chosen = '';

    class TemplateSuggestModal extends SuggestModal<string> {
      override getSuggestions(query: string): string[] {
        return ['Daily/2026-08-04', 'TaskNotes/Start Here', 'Untitled']
          .filter((item) => item.toLowerCase().includes(query.toLowerCase()));
      }
      override onChooseSuggestion(item: string): void { chosen = item; }
    }

    const modal = new TemplateSuggestModal(getPluginApp());
    modal.setPlaceholder('Type name of a template...');
    modal.open();

    await vi.waitFor(() => expect(modal.resultContainerEl.querySelectorAll('.suggestion-item')).toHaveLength(3));
    expect(themeRoot.contains(modal.containerEl)).toBe(true);
    expect(modal.modalEl.classList.contains('plugin-suggest-modal')).toBe(true);
    expect(modal.resultContainerEl.querySelector('.suggestion-item.is-selected')?.textContent).toBe('Daily/2026-08-04');

    modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(modal.resultContainerEl.querySelector('.suggestion-item.is-selected')?.textContent).toBe('TaskNotes/Start Here');
    modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(chosen).toBe('TaskNotes/Start Here');
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it('provides the browser modules externalized by Excalidraw and TaskNotes', () => {
    for (const moduleName of [
      '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/language',
      '@codemirror/state', '@codemirror/view', '@lezer/lr', 'react',
      'ajv-formats/dist/formats', 'ajv/dist/runtime/equal',
    ]) {
      expect(runtimeRequire('fixture', moduleName), moduleName).toBeTruthy();
    }
    expect(() => runtimeRequire('fixture', 'electron')).toThrow(/Node\/Electron module/);
  });

  it('provides plugin local storage and the public Bases registration surface', () => {
    const obsidian = runtimeRequire('fixture', 'obsidian');
    const app = getPluginApp();
    app.saveLocalStorage('compat-fixture', { enabled: true });
    expect(app.loadLocalStorage('compat-fixture')).toEqual({ enabled: true });

    class FixturePlugin extends obsidian.Plugin { onload(): void {} }
    const plugin = new (FixturePlugin as any)(app, { id: 'fixture', name: 'Fixture' });
    const registration = { name: 'Fixture', icon: 'table', factory: () => ({}) };
    expect(plugin.registerBasesView('fixture-view', registration)).toBe(true);
    const bases = app.internalPlugins.getEnabledPluginById('bases');
    expect(bases?.registrations['fixture-view']).toBe(registration);
    plugin.unload();
    expect(bases?.registrations['fixture-view']).toBeUndefined();
  });

  it('runs ribbon callbacks and reveals views created in the left sidebar', async () => {
    const app = getPluginApp();
    let sidebarLeaf: ReturnType<typeof app.workspace.getLeftLeaf> | null = null;

    class FixtureSidebarView extends ItemView {
      getViewType(): string { return 'fixture-sidebar-view'; }
      getDisplayText(): string { return 'Fixture sidebar'; }
      async onOpen(): Promise<void> { this.contentEl.textContent = 'Ribbon opened this view'; }
    }
    class FixturePlugin extends Plugin {
      onload(): void {
        this.registerView('fixture-sidebar-view', (leaf) => new FixtureSidebarView(leaf));
        this.addRibbonIcon('list', 'Open fixture sidebar', async () => {
          sidebarLeaf = this.app.workspace.getLeftLeaf(false);
          await sidebarLeaf.setViewState({ type: 'fixture-sidebar-view', active: true });
          await this.app.workspace.revealLeaf(sidebarLeaf);
        });
      }
    }

    useStore.setState({ pluginLeftPath: null, leftOpen: false, leftPanel: 'bookmarks' });
    const plugin = new FixturePlugin(app, { id: 'ribbon-fixture', name: 'Ribbon fixture' });
    await plugin.loadAsync();
    const ribbon = getPluginRuntimeSnapshot().ribbonItems.find((item) => item.pluginId === 'ribbon-fixture');
    expect(ribbon).toBeTruthy();
    expect(ribbon!.el.dataset.tooltip).toBe('Open fixture sidebar');
    expect(ribbon!.el.getAttribute('aria-label')).toBe('Open fixture sidebar');
    expect(ribbon!.el.hasAttribute('title')).toBe(false);

    ribbon!.el.click();
    await vi.waitFor(() => expect(useStore.getState().pluginLeftPath).toMatch(/^plugin-view:\/\/fixture-sidebar-view\//));
    expect(useStore.getState().leftOpen).toBe(true);
    expect((sidebarLeaf as WorkspaceLeaf | null)?.region).toBe('left');
    expect(app.workspace.getLeavesOfType('fixture-sidebar-view')).toEqual([sidebarLeaf]);

    useStore.getState().setLeftPanel('files');
    expect(useStore.getState().pluginLeftPath).toBeNull();
    await app.workspace.revealLeaf(sidebarLeaf!);
    expect(useStore.getState().pluginLeftPath).toMatch(/^plugin-view:\/\/fixture-sidebar-view\//);

    plugin.unload();
    expect(useStore.getState().pluginLeftPath).toBeNull();
    expect(getPluginRuntimeSnapshot().ribbonItems.some((item) => item.pluginId === 'ribbon-fixture')).toBe(false);
  });

  it('renders plugin settings with the Obsidian DOM and component contracts', async () => {
    const app = getPluginApp();
    let shortcut: any;

    class FixtureSettingsTab extends PluginSettingTab {
      display(): void {
        this.containerEl.replaceChildren();
        const momentGlobal = (window as any).moment;
        new Setting(this.containerEl)
          .setName(`Today: ${momentGlobal('2026-08-04').format('YYYY-MM-DD')}`)
          .setDesc('A visible setting')
          .addDropdown((dropdown) => dropdown.addOption('emoji', 'Tasks Emoji Format').setValue('emoji'));
        new Setting(this.containerEl).setName('Hidden setting').setVisibility(false);
        new Setting(this.containerEl).setName('Actions').addExtraButton((button) => {
          button.extraSettingsEl.classList.add('fixture-extra-button');
          button.setIcon('settings').setTooltip('Configure');
        });
      }
    }

    class FixturePlugin extends Plugin {
      onload(): void {
        shortcut = this.app.scope.register([], 'Tab', () => false);
        this.addSettingTab(new FixtureSettingsTab(this.app, this));
      }
      onunload(): void { this.app.scope.unregister(shortcut); }
    }

    const plugin = new FixturePlugin(app, { id: 'settings-fixture', name: 'Settings fixture' });
    await plugin.loadAsync();
    try {
      const tab = getPluginRuntimeSnapshot().settingTabs.find((item) => item.pluginId === 'settings-fixture');
      expect(tab).toBeTruthy();
      tab!.tab.display();
      expect(tab!.tab.containerEl.querySelectorAll('.setting-item')).toHaveLength(3);
      expect(tab!.tab.containerEl.querySelector<HTMLElement>('.setting-item:nth-child(2)')?.hidden).toBe(true);
      expect(tab!.tab.containerEl.querySelector('.fixture-extra-button')).toBeTruthy();
      expect(tab!.tab.containerEl.querySelector('option')?.textContent).toBe('Tasks Emoji Format');
    } finally {
      plugin.unload();
    }
    expect(getPluginRuntimeSnapshot().settingTabs.some((item) => item.pluginId === 'settings-fixture')).toBe(false);
  });

  it('shows a recoverable error instead of blanking settings when a plugin display fails', async () => {
    const app = getPluginApp();
    class BrokenSettingsTab extends PluginSettingTab {
      display(): void { throw new Error('Unsupported fixture setting'); }
    }
    class FixturePlugin extends Plugin { onload(): void {} }
    const plugin = new FixturePlugin(app, { id: 'broken-settings-fixture', name: 'Broken settings fixture' });
    const tab = new BrokenSettingsTab(app, plugin);
    const contribution = { id: 'broken-settings-fixture:settings', pluginId: plugin.manifest.id, name: 'Broken settings', tab };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => { root.render(createElement(PluginSettingsPanel, { tab: contribution })); });
      expect(container.textContent).toContain("Could not render this plugin's settings.");
      expect(container.textContent).toContain('Unsupported fixture setting');
      expect(container.querySelector('.plugin-settings-error')).toBeTruthy();
      expect(container.querySelector('.plugin-settings-host')).toBeTruthy();
    } finally {
      await act(async () => { root.unmount(); });
      consoleError.mockRestore();
    }
  });
});

describe.skipIf(!realBundlesAvailable)('current plugin release bundles', () => {
  const fixtures = [
    { id: 'breadcrumbs', file: 'breadcrumbs-main.js', name: 'Breadcrumbs', version: '4.21.9' },
    { id: 'notebook-navigator', file: 'notebook-navigator-main.js', name: 'Notebook Navigator', version: '3.3.0' },
    { id: 'tasknotes', file: 'tasknotes-main.js', name: 'TaskNotes', version: '4.11.1' },
    { id: 'obsidian-excalidraw-plugin', file: 'excalidraw-main.js', name: 'Excalidraw', version: '2.25.3' },
  ];

  for (const fixture of fixtures) {
    it(`evaluates and runs onload for ${fixture.name} ${fixture.version}`, { timeout: 30_000 }, async () => {
      const source = readFileSync(path.join(bundleDir, fixture.file), 'utf8');
      const module = { exports: {} as any };
      const evaluate = new Function('module', 'exports', 'require', source);
      evaluate(module, module.exports, (name: string) => runtimeRequire(fixture.id, name));
      const PluginClass = module.exports?.default ?? module.exports;
      expect(typeof PluginClass).toBe('function');

      const app = getPluginApp();
      const manifest = {
        ...fixture,
        author: 'Compatibility test',
        description: '',
        minAppVersion: '1.0.0',
        dir: `.obsidian/plugins/${fixture.id}`,
        isDesktopOnly: false,
      };
      const plugin = new PluginClass(app, manifest);
      app.plugins.plugins[fixture.id] = plugin;
      app.plugins.manifests[fixture.id] = manifest;
      app.plugins.enabledPlugins.add(fixture.id);
      const onLayoutReady = app.workspace.onLayoutReady;
      // This group verifies synchronous plugin evaluation/onload only. Running
      // deferred post-layout startup and immediately unloading can leave a
      // plugin's own async work racing its teardown and create false failures.
      app.workspace.onLayoutReady = () => {};
      try {
        await plugin.loadAsync();
      } finally {
        app.workspace.onLayoutReady = onLayoutReady;
        try { plugin.unload(); } catch { /* a failed onload may leave partial plugin state */ }
        delete app.plugins.plugins[fixture.id];
        delete app.plugins.manifests[fixture.id];
        app.plugins.enabledPlugins.delete(fixture.id);
      }
    });
  }

  it('opens Notebook Navigator from its real ribbon button in the left sidebar', { timeout: 30_000 }, async () => {
    const fixture = fixtures[1];
    const source = readFileSync(path.join(bundleDir, fixture.file), 'utf8');
    const module = { exports: {} as any };
    new Function('module', 'exports', 'require', source)(
      module,
      module.exports,
      (name: string) => runtimeRequire(fixture.id, name),
    );
    const PluginClass = module.exports?.default ?? module.exports;
    const app = getPluginApp();
    const manifest = {
      ...fixture,
      author: 'Compatibility test',
      description: '',
      minAppVersion: '1.0.0',
      dir: `.obsidian/plugins/${fixture.id}`,
      isDesktopOnly: false,
    };
    const plugin = new PluginClass(app, manifest);
    app.plugins.plugins[fixture.id] = plugin;
    app.plugins.manifests[fixture.id] = manifest;
    app.plugins.enabledPlugins.add(fixture.id);
    useStore.setState({ pluginLeftPath: null, leftOpen: false });
    try {
      await plugin.loadAsync();
      const ribbon = getPluginRuntimeSnapshot().ribbonItems.find((item) => item.pluginId === fixture.id);
      expect(ribbon).toBeTruthy();
      ribbon!.el.click();
      await vi.waitFor(() => expect(typeof useStore.getState().pluginLeftPath).toBe('string'), { timeout: 10_000 });
      const path = useStore.getState().pluginLeftPath!;
      expect(path).toMatch(/^plugin-view:\/\//);
      const viewType = decodeURIComponent(path.slice('plugin-view://'.length).split('/')[0]);
      expect(app.workspace.getLeavesOfType(viewType)[0]?.region).toBe('left');
    } finally {
      try { plugin.unload(); } catch { /* a failed ribbon action may leave partial plugin state */ }
      delete app.plugins.plugins[fixture.id];
      delete app.plugins.manifests[fixture.id];
      app.plugins.enabledPlugins.delete(fixture.id);
    }
  });
});

describe.skipIf(!tasksBundlePath || !existsSync(tasksBundlePath))('Tasks plugin settings', () => {
  it('renders the real Tasks settings tab', { timeout: 30_000 }, async () => {
    const source = readFileSync(tasksBundlePath!, 'utf8');
    const module = { exports: {} as any };
    new Function('module', 'exports', 'require', source)(
      module,
      module.exports,
      (name: string) => runtimeRequire('obsidian-tasks-plugin', name),
    );
    const PluginClass = module.exports?.default ?? module.exports;
    const app = getPluginApp();
    const manifest = {
      id: 'obsidian-tasks-plugin',
      name: 'Tasks',
      version: '8.3.0',
      author: 'Compatibility test',
      description: '',
      minAppVersion: '1.0.0',
      dir: '.obsidian/plugins/obsidian-tasks-plugin',
      isDesktopOnly: false,
    };
    const plugin = new PluginClass(app, manifest);
    app.plugins.plugins[manifest.id] = plugin;
    app.plugins.manifests[manifest.id] = manifest;
    app.plugins.enabledPlugins.add(manifest.id);
    const onLayoutReady = app.workspace.onLayoutReady;
    app.workspace.onLayoutReady = () => {};
    try {
      await plugin.loadAsync();
      const tab = getPluginRuntimeSnapshot().settingTabs.find((item) => item.pluginId === manifest.id);
      expect(tab).toBeTruthy();
      tab!.tab.display();
      expect(tab!.tab.containerEl.querySelectorAll('.setting-item').length).toBeGreaterThan(5);
    } finally {
      app.workspace.onLayoutReady = onLayoutReady;
      try { plugin.unload(); } catch { /* a failed settings render may leave partial plugin state */ }
      delete app.plugins.plugins[manifest.id];
      delete app.plugins.manifests[manifest.id];
      app.plugins.enabledPlugins.delete(manifest.id);
    }
  });
});

describe.skipIf(!calendarBundlePath || !existsSync(calendarBundlePath))('Calendar plugin settings', () => {
  it('renders the real Calendar settings tab', { timeout: 30_000 }, async () => {
    const source = readFileSync(calendarBundlePath!, 'utf8');
    const module = { exports: {} as any };
    new Function('module', 'exports', 'require', source)(
      module,
      module.exports,
      (name: string) => runtimeRequire('calendar', name),
    );
    const PluginClass = module.exports?.default ?? module.exports;
    const app = getPluginApp();
    const manifest = {
      id: 'calendar',
      name: 'Calendar',
      version: '1.5.10',
      author: 'Compatibility test',
      description: '',
      minAppVersion: '0.9.11',
      dir: '.obsidian/plugins/calendar',
      isDesktopOnly: false,
    };
    const plugin = new PluginClass(app, manifest);
    app.plugins.plugins[manifest.id] = plugin;
    app.plugins.manifests[manifest.id] = manifest;
    app.plugins.enabledPlugins.add(manifest.id);
    const onLayoutReady = app.workspace.onLayoutReady;
    app.workspace.onLayoutReady = () => {};
    try {
      await plugin.loadAsync();
      const tab = getPluginRuntimeSnapshot().settingTabs.find((item) => item.pluginId === manifest.id);
      expect(tab).toBeTruthy();
      tab!.tab.display();
      expect(tab!.tab.containerEl.querySelectorAll('.setting-item').length).toBeGreaterThan(3);
    } finally {
      app.workspace.onLayoutReady = onLayoutReady;
      try { plugin.unload(); } catch { /* a failed settings render may leave partial plugin state */ }
      delete app.plugins.plugins[manifest.id];
      delete app.plugins.manifests[manifest.id];
      app.plugins.enabledPlugins.delete(manifest.id);
    }
  });
});

describe.skipIf(!templaterBundlePath || !existsSync(templaterBundlePath))('Templater plugin', () => {
  it('evaluates and runs onload for the published Templater bundle', { timeout: 30_000 }, async () => {
    const source = readFileSync(templaterBundlePath!, 'utf8');
    const module = { exports: {} as any };
    new Function('module', 'exports', 'require', source)(
      module,
      module.exports,
      (name: string) => runtimeRequire('templater-obsidian', name),
    );
    const PluginClass = module.exports?.default ?? module.exports;
    expect(typeof PluginClass).toBe('function');

    const app = getPluginApp();
    const manifest = {
      id: 'templater-obsidian',
      name: 'Templater',
      version: '2.24.3',
      author: 'SilentVoid',
      description: '',
      minAppVersion: '1.13.0',
      dir: '.obsidian/plugins/templater-obsidian',
      isDesktopOnly: false,
    };
    const plugin = new PluginClass(app, manifest);
    app.plugins.plugins[manifest.id] = plugin;
    app.plugins.manifests[manifest.id] = manifest;
    app.plugins.enabledPlugins.add(manifest.id);
    const onLayoutReady = app.workspace.onLayoutReady;
    app.workspace.onLayoutReady = () => {};
    try {
      await plugin.loadAsync();
      const tab = getPluginRuntimeSnapshot().settingTabs.find((item) => item.pluginId === manifest.id);
      expect(tab).toBeTruthy();
      tab!.tab.display();
      expect(tab!.tab.containerEl.querySelectorAll('.setting-item').length).toBeGreaterThan(5);
    } finally {
      app.workspace.onLayoutReady = onLayoutReady;
      try { plugin.unload(); } catch { /* a failed onload may leave partial plugin state */ }
      delete app.plugins.plugins[manifest.id];
      delete app.plugins.manifests[manifest.id];
      app.plugins.enabledPlugins.delete(manifest.id);
    }
  });
});
