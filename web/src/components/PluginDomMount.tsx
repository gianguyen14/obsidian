import { useLayoutEffect, useRef } from 'react';

/** Mount a DOM node created and owned by an Obsidian community plugin. */
export default function PluginDomMount({ el, className = '' }: { el: HTMLElement; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    parent.appendChild(el);
    return () => {
      // Keep the plugin-owned node alive while React switches views. Its plugin
      // lifecycle removes it when the plugin is actually disabled/unloaded.
      if (el.parentElement === parent) parent.removeChild(el);
    };
  }, [el]);
  return <div ref={host} className={`plugin-dom-host ${className}`.trim()} />;
}
