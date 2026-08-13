import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ensurePluginViewForPath,
  getPluginRuntimeSnapshot,
  subscribePluginRuntime,
  type View,
} from '../lib/plugins';
import PluginDomMount from './PluginDomMount';

export default function PluginViewHost({ path }: { path: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const runtime = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginRuntimeSnapshot,
    getPluginRuntimeSnapshot,
  );

  useEffect(() => {
    let cancelled = false;
    setError('');
    ensurePluginViewForPath(path)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        if (!next && runtime.revision > 0) setError('The plugin that registered this view is disabled or failed to load.');
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [path, runtime.revision]);

  if (error) return <div className="plugin-view-error">Plugin view failed: {error}</div>;
  if (!view) return <div className="plugin-view-loading">Loading plugin view…</div>;
  return <PluginDomMount el={view.containerEl} className="plugin-view-host" />;
}
