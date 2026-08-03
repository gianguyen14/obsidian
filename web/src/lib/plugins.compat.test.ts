// @vitest-environment happy-dom

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPluginApp,
  getPluginRuntimeSnapshot,
  initializePluginRuntime,
  ItemView,
  Plugin,
  WorkspaceLeaf,
} from './plugins';
import { useStore } from './store';

const bundleDir = process.env.PLUGIN_BUNDLE_DIR ?? '/tmp/webobsidian-plugin-audit.RaAYbg';
const realBundlesAvailable = existsSync(bundleDir);

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
      'SettingGroup', 'SettingPage', 'WorkspaceSplit',
    ];
    const helperNames = [
      'arrayBufferToBase64', 'base64ToArrayBuffer', 'getIconIds', 'getLanguage',
      'htmlToMarkdown', 'loadPdfJs', 'parseFrontMatterEntry', 'prepareFuzzySearch',
      'prepareSimpleSearch', 'renderMatches',
    ];
    classNames.forEach((name) => expect(typeof obsidian[name], name).toBe('function'));
    helperNames.forEach((name) => expect(typeof obsidian[name], name).toBe('function'));
    expect(obsidian.apiVersion).toBe('1.13.1');
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
    expect(() => runtimeRequire('fixture', 'obsidian').DefinitelyMissing).toThrow(/unsupported Obsidian API/);
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
