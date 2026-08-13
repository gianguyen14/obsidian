// @vitest-environment happy-dom

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import BasesPluginView from './BasesPluginView';
import { parseBaseDefinition } from '../lib/bases';
import type { BasesSourceFile } from '../lib/basesRuntime';
import type { ObsidianFileCache } from '../lib/api';

const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

// The `daysUntilDue` formula below subtracts `today()` from a fixed due date,
// so the expected result depends on what day it is. Freeze the clock to NOW,
// otherwise the assertion silently expires the day after it is written.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const definition = parseBaseDefinition(`
filters:
  and:
    - file.hasTag("task")
formulas:
  daysUntilDue: 'if((due.isEmpty() == false), ((number(date(due)) - number(today())) / 86400000).floor(), null)'
views:
  - type: fixtureCalendar
    name: Calendar
    order:
      - file.name
    options:
      calendarView: timeGridWeek
`).definition;

function file(path: string, frontmatter: Record<string, unknown>, tags = ['#task']): BasesSourceFile {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    extension: 'md',
    stat: { size: 10, ctime: NOW, mtime: NOW },
    cache: {
      frontmatter,
      tags: tags.map((tag) => ({ tag, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } })),
      headings: [], links: [], embeds: [], listItems: [], sections: [],
    } as unknown as ObsidianFileCache,
  };
}

async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe('BasesPluginView', () => {
  it('injects app/config/data and calls onDataUpdated after the factory', async () => {
    const order: string[] = [];
    let seen: any = null;
    const registration = {
      name: 'Fixture calendar',
      factory: (controller: any, containerEl: HTMLElement) => {
        order.push('factory');
        const view: any = {
          onDataUpdated() {
            order.push('onDataUpdated');
            // Everything the real renderers read must already be present here.
            seen = {
              hasApp: Boolean(this.app),
              calendarView: this.config.get('calendarView'),
              order: this.config.getOrder(),
              rows: this.data.data.length,
              groups: this.data.groupedData.length,
              grouped: this.data.groupedData[0].hasKey(),
              formula: this.data.data[0]?.formulaResults.cachedFormulaOutputs.daysUntilDue,
              path: this.data.data[0]?.file.path,
              controllerView: controller.view === view,
            };
            containerEl.textContent = `rows:${this.data.data.length}`;
          },
        };
        return view;
      },
    };

    const files = [file('Tasks/A.md', { due: '2026-08-08' }), file('Notes/B.md', {}, ['#note'])];
    const { container, unmount } = await render(createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files,
      onError: () => { }, onCount: () => { },
    }));

    expect(order).toEqual(['factory', 'onDataUpdated']);
    expect(seen).toMatchObject({
      hasApp: true,
      calendarView: 'timeGridWeek',
      order: ['file.name'],
      rows: 1,
      groups: 1,
      grouped: false,
      formula: 2,
      path: 'Tasks/A.md',
      controllerView: true,
    });
    expect(container.textContent).toContain('rows:1');
    await unmount();
  });

  it('reports the query result count', async () => {
    const counts: number[] = [];
    const registration = { factory: () => ({ onDataUpdated: () => { } }) };
    const files = [file('a.md', {}), file('b.md', {}), file('c.md', {}, ['#note'])];
    const { unmount } = await render(createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files,
      onError: () => { }, onCount: (count: number) => counts.push(count),
    }));
    expect(counts.at(-1)).toBe(2);
    await unmount();
  });

  it('surfaces an error instead of blanking when the factory throws', async () => {
    const registration = {
      factory: () => { throw new Error('Fixture factory failure'); },
    };
    const onError = vi.fn();
    const { container, unmount } = await render(createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files: [file('a.md', {})],
      onError, onCount: () => { },
    }));
    expect(onError).toHaveBeenCalledWith('Fixture factory failure');
    expect(container.textContent).toContain('could not be rendered');
    await unmount();
  });

  it('surfaces an error when onDataUpdated throws', async () => {
    const registration = {
      factory: () => ({ onDataUpdated: () => { throw new Error('Fixture render failure'); } }),
    };
    const onError = vi.fn();
    const { unmount } = await render(createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files: [file('a.md', {})],
      onError, onCount: () => { },
    }));
    expect(onError).toHaveBeenCalledWith('Fixture render failure');
    await unmount();
  });

  it('reuses the view instance across data updates and unloads it once', async () => {
    let built = 0;
    let unloaded = 0;
    let updates = 0;
    const registration = {
      factory: () => {
        built += 1;
        return { onDataUpdated: () => { updates += 1; }, onunload: () => { unloaded += 1; } };
      },
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = (files: BasesSourceFile[]) => createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files,
      onError: () => { }, onCount: () => { },
    });

    await act(async () => { root.render(props([file('a.md', {})])); });
    await act(async () => { root.render(props([file('a.md', {}), file('b.md', {})])); });

    // New data must not re-run the factory, or the plugin would lose its state.
    expect(built).toBe(1);
    expect(updates).toBe(2);

    await act(async () => { root.unmount(); });
    expect(unloaded).toBe(1);
    container.remove();
  });

  it('tolerates a view that throws while unloading', async () => {
    const registration = {
      factory: () => ({ onDataUpdated: () => { }, onunload: () => { throw new Error('bad teardown'); } }),
    };
    const { unmount } = await render(createElement(BasesPluginView, {
      registration, definition, view: definition.views[0], files: [file('a.md', {})],
      onError: () => { }, onCount: () => { },
    }));
    await expect(unmount()).resolves.toBeUndefined();
  });
});
