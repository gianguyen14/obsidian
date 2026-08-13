// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import BaseView from '../components/BaseView';
import { useStore } from './store';
import {
  basePropertyLabel,
  describeBaseFilters,
  getBaseFilterTag,
  parseBaseDefinition,
} from './bases';

const TASKNOTES_BASE = `
filters:
  and:
    - file.hasTag("task")
properties:
  formula.dueIn:
    displayName: Due in
views:
  - type: tasknotesTaskList
    name: Manual Order
    order: [status, priority, formula.dueIn, file.name]
    sort:
      - column: tasknotes_manual_order
        direction: DESC
    groupBy:
      property: status
      direction: ASC
  - type: tasknotesTaskList
    name: All Tasks
`;

describe('Bases definitions', () => {
  it('parses TaskNotes views and normalizes toolbar metadata', () => {
    const { definition, error } = parseBaseDefinition(TASKNOTES_BASE);
    expect(error).toBe('');
    expect(definition.views.map((view) => view.name)).toEqual(['Manual Order', 'All Tasks']);
    expect(definition.views[0].sort).toEqual([{ column: 'tasknotes_manual_order', direction: 'DESC' }]);
    expect(getBaseFilterTag(definition, definition.views[0])).toBe('task');
    expect(basePropertyLabel(definition, 'formula.dueIn')).toBe('Due in');
    expect(basePropertyLabel(definition, 'tasknotes_manual_order')).toBe('Tasknotes manual order');
  });

  it('keeps nested filters readable in the Filter menu', () => {
    expect(describeBaseFilters({ and: ['status != "done"', { or: ['due < today()', 'scheduled < today()'] }] }))
      .toEqual([
        'All: status != "done"',
        'All: Any: due < today()',
        'All: Any: scheduled < today()',
      ]);
  });

  it('renders an empty Base as the default Table view and reports invalid YAML', () => {
    expect(parseBaseDefinition('').definition.views[0]).toMatchObject({ type: 'table', name: 'Table' });
    expect(parseBaseDefinition('views: [').error).not.toBe('');
  });

  it('renders the Obsidian Bases toolbar instead of a blank text editor', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ hits: [] }))));
    useStore.setState({
      activePath: 'TaskNotes/Views/tasks-default.base',
      content: TASKNOTES_BASE,
      tree: null,
      contextMenu: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(BaseView)); });
      await vi.waitFor(() => expect(container.querySelector('.bases-loading')).toBeNull());
      expect(container.querySelector('.bases-view-select')?.textContent).toContain('Manual Order');
      expect([...container.querySelectorAll('.bases-toolbar-button')].map((button) => button.textContent?.trim()))
        .toEqual(expect.arrayContaining(['Sort', 'Filter', 'Properties', 'Search', 'New']));
      expect(container.querySelector('.bases-result-count')?.textContent).toContain('0 results');
      expect(container.querySelector('.bases-empty')?.textContent).toBe('No tasknotes tasks found for this base.');

      await act(async () => { (container.querySelector('.bases-toolbar-button:nth-last-child(2)') as HTMLButtonElement).click(); });
      expect(container.querySelector<HTMLInputElement>('.bases-search-row input')?.placeholder).toBe('Search Manual Order');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
