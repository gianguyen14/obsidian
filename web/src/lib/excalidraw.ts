import { api } from './api';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';

export const EXCALIDRAW_RE = /\.excalidraw$/i;

export const EMPTY_EXCALIDRAW = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'webobsidian',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  },
  null,
  2,
);

export function parseExcalidraw(content: string): ExcalidrawInitialDataState {
  const parsed = JSON.parse(content || EMPTY_EXCALIDRAW) as ExcalidrawInitialDataState;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.elements)) {
    throw new Error('Invalid Excalidraw file');
  }
  return {
    ...parsed,
    elements: parsed.elements,
    appState: parsed.appState ?? { viewBackgroundColor: '#ffffff' },
    files: parsed.files ?? {},
    scrollToContent: true,
  };
}

function cleanExportedSvg(svg: SVGSVGElement): SVGSVGElement {
  svg.querySelectorAll('script, foreignObject').forEach((node) => node.remove());
  for (const el of svg.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'xlink:href') && !/^(#|https?:|mailto:|data:image\/)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return svg;
}

/** Convert an Excalidraw scene to a safe, standalone SVG element. */
export async function sceneToSvg(scene: ExcalidrawInitialDataState): Promise<SVGSVGElement> {
  const { exportToSvg, getNonDeletedElements, restore } = await import('@excalidraw/excalidraw');
  const restored = restore(scene, null, null);
  const svg = await exportToSvg({
    elements: getNonDeletedElements(restored.elements),
    appState: {
      ...restored.appState,
      exportBackground: true,
      exportWithDarkMode: false,
    },
    files: restored.files,
    exportPadding: 16,
    renderEmbeddables: false,
  });
  return cleanExportedSvg(svg);
}

/**
 * Render a `![[drawing.excalidraw]]` preview into an existing DOM node.
 * Returns a cleanup function so CodeMirror/React can cancel an in-flight render.
 */
export function renderExcalidrawEmbed(
  container: HTMLElement,
  target: string,
  options: { width?: number; onOpen?: () => void } = {},
): () => void {
  let cancelled = false;
  container.classList.add('excalidraw-embed');
  container.dataset.excalidrawHydrated = '1';
  if (options.width) container.style.maxWidth = `${options.width}px`;
  container.textContent = 'Loading drawing…';

  void (async () => {
    try {
      const resolved = await api.resolve(target).catch(() => ({ path: target }));
      const path = resolved.path || target;
      const result = await api.read(path);
      const content = typeof result === 'string' ? result : result.content;
      const svg = await sceneToSvg(parseExcalidraw(content));
      if (cancelled || !container.isConnected) return;
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', target);
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      container.replaceChildren(svg);
      container.title = `Open ${target}`;
      if (options.onOpen) {
        container.tabIndex = 0;
        container.setAttribute('role', 'button');
        container.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onOpen?.();
        };
        container.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            options.onOpen?.();
          }
        };
      }
    } catch {
      if (cancelled || !container.isConnected) return;
      container.classList.add('is-missing');
      container.textContent = `Drawing “${target}” could not be rendered.`;
    }
  })();

  return () => {
    cancelled = true;
    container.onclick = null;
    container.onkeydown = null;
  };
}

/** Hydrate all reading-view Excalidraw placeholders under a rendered Markdown root. */
export function hydrateExcalidrawEmbeds(root: HTMLElement, onOpen: (target: string) => void): () => void {
  const cleanups: Array<() => void> = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-excalidraw]:not([data-excalidraw-hydrated])')) {
    const target = el.dataset.excalidraw;
    if (!target) continue;
    const width = Number(el.dataset.embedWidth) || undefined;
    cleanups.push(renderExcalidrawEmbed(el, target, { width, onOpen: () => onOpen(target) }));
  }
  return () => cleanups.forEach((cleanup) => cleanup());
}
