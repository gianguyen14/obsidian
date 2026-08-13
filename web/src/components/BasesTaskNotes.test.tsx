// @vitest-environment happy-dom

/**
 * End-to-end check against the real TaskNotes release in the vault: load the
 * bundle, let it register its Bases view types, then drive one through the host
 * with the shipped calendar-default.base. This is what the built-in flat-list
 * renderer could never do, so it is worth testing against the real bundle
 * rather than a fixture.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import BasesPluginView from './BasesPluginView';
import { parseBaseDefinition } from '../lib/bases';
import type { BasesSourceFile } from '../lib/basesRuntime';
import type { ObsidianFileCache } from '../lib/api';
import { getPluginApp, getPluginRuntimeSnapshot, initializePluginRuntime } from '../lib/plugins';

const pluginDir = path.resolve(__dirname, '../../../vault/.obsidian/plugins/tasknotes');
const bundlePath = path.join(pluginDir, 'main.js');
const basePath = path.resolve(__dirname, '../../../vault/TaskNotes/Views/calendar-default.base');
const available = existsSync(bundlePath) && existsSync(basePath);

const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

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
  if (url.includes('/api/search/metacache')) return Promise.resolve(Response.json({ caches: {}, resolvedLinks: {}, unresolvedLinks: {} }));
  if (url.includes('/api/search')) return Promise.resolve(Response.json({ results: [] }));
  return Promise.resolve(Response.json({ ok: true, plugins: [] }));
}

function file(relPath: string, frontmatter: Record<string, unknown>, tags = ['#task']): BasesSourceFile {
  return {
    path: relPath,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
    extension: 'md',
    stat: { size: 64, ctime: NOW, mtime: NOW },
    cache: {
      frontmatter,
      tags: tags.map((tag) => ({ tag, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } })),
      headings: [], links: [], embeds: [], listItems: [], sections: [],
    } as unknown as ObsidianFileCache,
  };
}

describe.skipIf(!available)('TaskNotes Bases views (real bundle)', () => {
  it('renders the shipped calendar base through the plugin renderer', { timeout: 60_000 }, async () => {
    // FullCalendar defaults to the current week. Freeze only Date so this
    // fixture remains visible after its original 2026-08-06 authoring date;
    // keep real setTimeout for the plugin's asynchronous layout work below.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    initializePluginRuntime();
    vi.stubGlobal('fetch', vi.fn(mockApiFetch));

    const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
    const source = readFileSync(bundlePath, 'utf8');
    const module = { exports: {} as any };
    new Function('module', 'exports', 'require', source)(
      module,
      module.exports,
      (name: string) => globalThis.__webObsidianRequire('tasknotes', name),
    );
    const PluginClass = module.exports?.default ?? module.exports;

    const app = getPluginApp();
    const plugin = new PluginClass(app, { ...manifest, dir: '.obsidian/plugins/tasknotes' });
    app.plugins.plugins.tasknotes = plugin;
    app.plugins.manifests.tasknotes = manifest;
    app.plugins.enabledPlugins.add('tasknotes');
    const onLayoutReady = app.workspace.onLayoutReady;
    app.workspace.onLayoutReady = () => { };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await plugin.loadAsync();

      // The plugin must have contributed its calendar view type.
      const registrations = getPluginRuntimeSnapshot().basesViews;
      expect(Object.keys(registrations)).toContain('tasknotesCalendar');

      const parsed = parseBaseDefinition(readFileSync(basePath, 'utf8'));
      expect(parsed.error).toBe('');
      const view = parsed.definition.views[0];
      expect(view.type).toBe('tasknotesCalendar');

      const files = [
        file('Tasks/Standup.md', { title: 'Standup', status: 'open', scheduled: '2026-08-06T09:00:00', due: '2026-08-06' }),
        file('Tasks/Review.md', { title: 'Review', status: 'open', due: '2026-08-07' }),
      ];

      const errors: string[] = [];
      let count = -1;
      await act(async () => {
        root.render(createElement(BasesPluginView, {
          registration: registrations.tasknotesCalendar,
          definition: parsed.definition,
          view,
          files,
          onError: (message: string) => errors.push(message),
          onCount: (value: number) => { count = value; },
        }));
      });
      // The calendar builds its grid and places events asynchronously.
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 500); }); });

      expect(errors).toEqual([]);
      expect(count).toBe(2);

      const host = container.querySelector('.bases-plugin-view');
      expect(host).toBeTruthy();
      // The fallback flat list must NOT be what rendered.
      expect(container.querySelector('.bases-task-list')).toBeNull();
      // TaskNotes' own FullCalendar week grid, matching desktop Obsidian: a
      // day column per weekday and the configured timeGridWeek range active.
      expect(host!.querySelector('.fc-timeGridWeek-view')).toBeTruthy();
      expect(host!.querySelectorAll('.fc-col-header-cell.fc-day').length).toBe(7);
      expect(host!.querySelector('.fc-timegrid-axis')).toBeTruthy();
      // The scheduled task must actually be placed as an event.
      const titles = [...host!.querySelectorAll('.fc-event-title')].map((el) => el.textContent);
      expect(titles).toContain('Standup');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      app.workspace.onLayoutReady = onLayoutReady;
      try { plugin.unload(); } catch { /* partial onload may leave state */ }
      delete app.plugins.plugins.tasknotes;
      delete app.plugins.manifests.tasknotes;
      app.plugins.enabledPlugins.delete('tasknotes');
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
