import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ObsidianFileCache, type TreeNode } from '../lib/api';
import type { BaseDefinition, BaseViewDefinition } from '../lib/bases';
import {
  buildBasesData,
  collectProperties,
  createQueryController,
  createViewConfig,
  type BasesSourceFile,
} from '../lib/basesRuntime';
import { getPluginApp, type BasesViewRegistration } from '../lib/plugins';
import PluginDomMount from './PluginDomMount';

/**
 * Host for a Bases view type contributed by a plugin.
 *
 * Bases does not pass the data to the factory. It calls
 * `factory(controller, containerEl)`, then injects `app`, `config` and `data`
 * onto the returned view object and calls `onDataUpdated()`. Plugins such as
 * TaskNotes rely on that exact order, so keep it intact.
 */
export default function BasesPluginView({
  registration,
  definition,
  view,
  files,
  onError,
  onCount,
}: {
  registration: BasesViewRegistration;
  definition: BaseDefinition;
  view: BaseViewDefinition;
  files: BasesSourceFile[];
  onError: (message: string) => void;
  onCount: (count: number) => void;
}) {
  const containerEl = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'bases-plugin-view';
    return el;
  }, [registration, view.type, view.name]);

  const viewRef = useRef<any>(null);
  const [failed, setFailed] = useState('');

  // Instantiate once per (registration, container): the plugin owns the DOM and
  // its own lifecycle, so re-running the factory on every data change would
  // leak listeners and reset scroll/UI state.
  useEffect(() => {
    let instance: any = null;
    try {
      const controller = createQueryController(definition, view);
      instance = registration.factory(controller, containerEl);
      if (!instance) throw new Error('Bases view factory returned nothing');
      controller.view = instance;
      instance.app = getPluginApp();
      viewRef.current = instance;
      setFailed('');
      instance.onload?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      viewRef.current = null;
      setFailed(message);
      onError(message);
      return;
    }
    return () => {
      viewRef.current = null;
      try {
        instance.onunload?.();
        instance.unload?.();
        instance.destroy?.();
      } catch {
        // A plugin that throws while tearing down must not break navigation.
      }
      containerEl.replaceChildren();
    };
    // definition/view identity changes are handled by the data effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration, containerEl]);

  // Push data whenever the query result changes.
  useEffect(() => {
    const instance = viewRef.current;
    if (!instance) return;
    try {
      const { data, entries } = buildBasesData(definition, view, files, Date.now());
      onCount(entries.length);
      instance.config = createViewConfig(definition, view, () => {
        // A config edit from the view's own UI (changing the calendar range,
        // for example) must re-render it with the same data.
        try {
          instance.onDataUpdated?.();
        } catch {
          // Swallow: the view's refresh path is its own concern.
        }
      });
      instance.data = data;
      instance.allProperties = collectProperties(definition, entries);
      instance.onDataUpdated?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailed(message);
      onError(message);
    }
  }, [definition, view, files, onError, onCount]);

  if (failed) {
    return (
      <div className="bases-error">
        <strong>This Bases view could not be rendered.</strong>
        <span>{failed}</span>
      </div>
    );
  }
  return <PluginDomMount el={containerEl} className="bases-plugin-host" />;
}

/**
 * Load the metadata cache for every markdown file, for query evaluation.
 * `tree` supplies size/ctime/mtime, which the metadata cache itself does not
 * carry but `file.mtime` formulas and sort rules need.
 */
export function useBasesSourceFiles(enabled: boolean, tree: TreeNode | null) {
  const [caches, setCaches] = useState<Record<string, ObsidianFileCache>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setCaches({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.metaCache()
      .then((result) => { if (!cancelled) setCaches(result.caches); })
      .catch(() => { if (!cancelled) setCaches({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, tree]);

  const files = useMemo(() => {
    const stats = new Map<string, { size: number; ctime: number; mtime: number }>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder') walk(node.children ?? []);
        else stats.set(node.path, { size: node.size ?? 0, ctime: node.ctime ?? 0, mtime: node.mtime ?? 0 });
      }
    };
    walk(tree ? [tree] : []);
    return Object.entries(caches).map(([path, cache]) => ({
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      extension: (path.match(/\.([^./]+)$/)?.[1] ?? 'md').toLowerCase(),
      stat: stats.get(path) ?? { size: 0, ctime: 0, mtime: 0 },
      cache,
    } satisfies BasesSourceFile));
  }, [caches, tree]);

  return { files, loading };
}
