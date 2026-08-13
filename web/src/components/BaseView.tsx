import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type SearchHit } from '../lib/api';
import {
  basePropertyLabel,
  describeBaseFilters,
  getBaseFilterTag,
  parseBaseDefinition,
  type BaseViewDefinition,
} from '../lib/bases';
import {
  canRunPluginCommand,
  getPluginRuntimeSnapshot,
  runPluginCommand,
  subscribePluginRuntime,
} from '../lib/plugins';
import BasesPluginView, { useBasesSourceFiles } from './BasesPluginView';
import { useStore, type ContextMenuItem } from '../lib/store';
import Icon from './Icon';

function menuPosition(target: EventTarget & HTMLElement) {
  const rect = target.getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) + 5 };
}
function taskTitle(hit: SearchHit): string {
  return hit.title || (hit.path.split('/').pop() ?? hit.path).replace(/\.(md|markdown)$/i, '');
}

export default function BaseView() {
  const activePath = useStore((state) => state.activePath);
  const content = useStore((state) => state.content);
  const tree = useStore((state) => state.tree);
  const openFile = useStore((state) => state.openFile);
  const openContextMenu = useStore((state) => state.openContextMenu);
  const notify = useStore((state) => state.notify);
  const parsed = useMemo(() => parseBaseDefinition(content), [content]);
  const [viewIndex, setViewIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const pluginRuntime = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginRuntimeSnapshot,
    getPluginRuntimeSnapshot,
  );

  const view = parsed.definition.views[Math.min(viewIndex, parsed.definition.views.length - 1)]
    ?? parsed.definition.views[0];
  const taskTag = useMemo(
    () => getBaseFilterTag(parsed.definition, view),
    [parsed.definition, view],
  );

  // A plugin-contributed view type (tasknotesCalendar, …) renders itself; the
  // built-in flat list is only the fallback for types nothing registered.
  const registration = pluginRuntime.basesViews[view.type];
  const [renderError, setRenderError] = useState('');
  const [queryCount, setQueryCount] = useState(0);
  const { files: sourceFiles, loading: sourceLoading } = useBasesSourceFiles(Boolean(registration), tree);

  useEffect(() => { setRenderError(''); }, [view.type, activePath]);

  useEffect(() => {
    setViewIndex(0);
    setSearchOpen(false);
    setSearch('');
  }, [activePath]);

  useEffect(() => {
    if (viewIndex < parsed.definition.views.length) return;
    setViewIndex(0);
  }, [parsed.definition.views.length, viewIndex]);

  useEffect(() => {
    if (!searchOpen) return;
    window.setTimeout(() => searchInput.current?.focus(), 0);
  }, [searchOpen]);

  const pluginRendered = Boolean(registration) && !renderError;

  useEffect(() => {
    let cancelled = false;
    // The plugin renderer runs the real Bases query itself; this tag search is
    // only for the fallback list, including when that renderer failed.
    if (!taskTag || pluginRendered) {
      setHits([]);
      return;
    }
    setLoading(true);
    api.search(`tag:${taskTag}`)
      .then(({ hits: next }) => { if (!cancelled) setHits(next); })
      .catch(() => { if (!cancelled) setHits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskTag, tree, pluginRendered]);

  const visibleHits = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return hits;
    return hits.filter((hit) => taskTitle(hit).toLowerCase().includes(query) || hit.path.toLowerCase().includes(query));
  }, [hits, search]);

  // With a plugin renderer the count comes from the executed query, not the
  // fallback list, so the toolbar cannot report the list length.
  const resultCount = pluginRendered ? queryCount : visibleHits.length;

  const showMenu = (target: EventTarget & HTMLElement, items: ContextMenuItem[]) => {
    openContextMenu({ ...menuPosition(target), items });
  };

  const openViews = (event: React.MouseEvent<HTMLButtonElement>) => {
    showMenu(event.currentTarget, parsed.definition.views.map((item, index) => ({
      label: item.name,
      icon: index === viewIndex ? 'check' : undefined,
      onClick: () => setViewIndex(index),
    })));
  };

  const openSort = (event: React.MouseEvent<HTMLButtonElement>) => {
    const items: ContextMenuItem[] = view.sort.length
      ? view.sort.map((rule) => ({
          label: `${basePropertyLabel(parsed.definition, rule.column)} · ${rule.direction === 'DESC' ? 'Descending' : 'Ascending'}`,
          icon: rule.direction === 'DESC' ? 'arrow-down' : 'arrow-up',
        }))
      : [{ label: 'No sorting rules', icon: 'minus' }];
    showMenu(event.currentTarget, items);
  };

  const openFilters = (event: React.MouseEvent<HTMLButtonElement>) => {
    const filters = [
      ...describeBaseFilters(parsed.definition.filters),
      ...describeBaseFilters(view.filters),
    ];
    showMenu(event.currentTarget, filters.length
      ? filters.map((filter) => ({ label: filter, icon: 'filter' }))
      : [{ label: 'No filters', icon: 'minus' }]);
  };

  const openProperties = (event: React.MouseEvent<HTMLButtonElement>) => {
    const properties = view.order.length ? view.order : Object.keys(parsed.definition.properties);
    showMenu(event.currentTarget, properties.length
      ? properties.map((property) => ({
          label: basePropertyLabel(parsed.definition, property),
          icon: 'check',
        }))
      : [{ label: 'No visible properties', icon: 'minus' }]);
  };

  const createTask = () => {
    const command = pluginRuntime.commands.find((item) => (
      item.pluginId === 'tasknotes'
      && (/(?:create|new).*(?:task)/i.test(item.name) || /(?:create|new).*(?:task)/i.test(item.id))
      && canRunPluginCommand(item.id)
    ));
    if (command && runPluginCommand(command.id)) return;
    notify('TaskNotes create-task command is not available');
  };

  const emptyText = view.type.startsWith('tasknotes')
    ? 'No tasknotes tasks found for this base.'
    : 'No results found for this base.';

  return (
    <div className="bases-view">
      <div className="bases-toolbar">
        <button className="bases-toolbar-button bases-view-select" type="button" onClick={openViews}>
          <Icon name={registration?.icon || (view.type.startsWith('tasknotes') ? 'check-square' : 'table')} size={17} />
          <span>{view.name}</span>
          <Icon name="chevrons-up-down" size={13} className="bases-view-chevron" />
        </button>
        <button
          className="bases-result-count"
          type="button"
          title="View result actions"
          onClick={(event) => showMenu(event.currentTarget, [
            { label: resultCount ? 'Copy results' : 'No results to copy', icon: 'copy' },
            { label: resultCount ? 'Export CSV' : 'No results to export', icon: 'file' },
          ])}
        >
          {resultCount} {resultCount === 1 ? 'result' : 'results'}
        </button>
        <span className="bases-toolbar-grow" />
        <button className="bases-toolbar-button" type="button" onClick={openSort}>
          <Icon name="arrow-up-down" size={17} />
          <span>Sort</span>
        </button>
        <button className="bases-toolbar-button" type="button" onClick={openFilters}>
          <Icon name="filter" size={17} />
          <span>Filter</span>
        </button>
        <button className="bases-toolbar-button" type="button" onClick={openProperties}>
          <Icon name="list-tree" size={17} />
          <span>Properties</span>
        </button>
        {/* Search filters the fallback list only; a plugin renderer owns its
            own filtering, so the control would do nothing there. */}
        {!pluginRendered && (
          <button
            className={`bases-toolbar-button ${searchOpen ? 'active' : ''}`}
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
          >
            <Icon name="search" size={17} />
            <span>Search</span>
          </button>
        )}
        <button className="bases-toolbar-button" type="button" onClick={createTask}>
          <Icon name="plus" size={17} />
          <span>New</span>
        </button>
      </div>

      {searchOpen && !pluginRendered && (
        <div className="bases-search-row">
          <Icon name="search" size={16} />
          <input
            ref={searchInput}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('');
                setSearchOpen(false);
              }
            }}
            placeholder={`Search ${view.name}`}
            aria-label={`Search ${view.name}`}
          />
          {search && (
            <button type="button" title="Clear search" onClick={() => setSearch('')}>
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
      )}

      <div className={`bases-content ${pluginRendered ? 'bases-content-plugin' : ''}`.trim()}>
        {parsed.error ? (
          <div className="bases-error">
            <strong>Could not read this Base.</strong>
            <span>{parsed.error}</span>
          </div>
        ) : pluginRendered ? (
          sourceLoading ? (
            <div className="bases-loading">Loading results…</div>
          ) : (
            <BasesPluginView
              key={`${activePath}:${view.type}:${view.name}`}
              registration={registration}
              definition={parsed.definition}
              view={view}
              files={sourceFiles}
              onError={setRenderError}
              onCount={setQueryCount}
            />
          )
        ) : loading ? (
          <div className="bases-loading">Loading results…</div>
        ) : visibleHits.length ? (
          <div className="bases-task-list" role="list">
            {visibleHits.map((hit) => (
              <button key={hit.path} className="bases-task-row" type="button" role="listitem" onClick={() => openFile(hit.path)}>
                <span className="bases-task-check"><Icon name="circle" size={16} /></span>
                <span className="bases-task-copy">
                  <span className="bases-task-title">{taskTitle(hit)}</span>
                  <span className="bases-task-path">{hit.path}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="bases-empty">{search ? `No results matching “${search}”.` : emptyText}</div>
        )}
        {registration && renderError && (
          <div className="bases-render-warning">
            {`The ${view.type} view from the plugin failed to render (${renderError}); showing a basic list instead.`}
          </div>
        )}
      </div>
    </div>
  );
}
