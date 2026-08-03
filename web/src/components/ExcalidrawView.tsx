import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Excalidraw,
  THEME,
  exportToBlob,
  exportToSvg,
  getNonDeletedElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { useStore } from '../lib/store';
import { parseExcalidraw } from '../lib/excalidraw';
import Icon from './Icon';

type ExportFormat = 'png' | 'svg';

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentTheme(): 'light' | 'dark' {
  return document.querySelector('.theme-dark') ? THEME.DARK : THEME.LIGHT;
}

export default function ExcalidrawView() {
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => s.content);
  const dirty = useStore((s) => s.dirty);
  const setContent = useStore((s) => s.setContent);
  const save = useStore((s) => s.save);
  const notify = useStore((s) => s.notify);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastWritten = useRef(content);
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);

  const initialData = useMemo(() => {
    try {
      return parseExcalidraw(content);
    } catch {
      return null;
    }
    // This component is keyed by activePath in Workspace, so initial data must
    // only be parsed once for each opened drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    const themeRoot = document.querySelector('.theme-dark, .theme-light');
    if (!themeRoot) return;
    const observer = new MutationObserver(sync);
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const id = window.setTimeout(() => {
      void save().catch((error) => notify(error?.message ?? 'Could not save drawing'));
    }, 900);
    return () => window.clearTimeout(id);
  }, [content, dirty, notify, save]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const next = serializeAsJSON(elements, appState, files, 'local');
      if (next === lastWritten.current) return;
      lastWritten.current = next;
      setContent(next);
    },
    [setContent],
  );

  const exportDrawing = useCallback(
    async (format: ExportFormat) => {
      const drawingApi = apiRef.current;
      if (!drawingApi || !activePath) return;
      const elements = getNonDeletedElements(drawingApi.getSceneElements());
      if (!elements.length) {
        notify('Drawing is empty');
        return;
      }
      const appState = { ...drawingApi.getAppState(), exportBackground: true };
      const files = drawingApi.getFiles();
      const base = (activePath.split('/').pop() ?? 'drawing').replace(/\.excalidraw$/i, '');
      try {
        if (format === 'png') {
          const blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png', exportPadding: 16 });
          download(blob, `${base}.png`);
        } else {
          const svg = await exportToSvg({ elements, appState, files, exportPadding: 16, renderEmbeddables: false });
          const source = new XMLSerializer().serializeToString(svg);
          download(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }), `${base}.svg`);
        }
        notify(`Exported ${base}.${format}`);
      } catch (error: any) {
        notify(error?.message ?? `Could not export ${format.toUpperCase()}`);
      }
    },
    [activePath, notify],
  );

  useEffect(() => {
    const onExport = (event: Event) => {
      const format = (event as CustomEvent<ExportFormat>).detail;
      if (format === 'png' || format === 'svg') void exportDrawing(format);
    };
    window.addEventListener('wo-excalidraw-export', onExport);
    return () => window.removeEventListener('wo-excalidraw-export', onExport);
  }, [exportDrawing]);

  if (!initialData) {
    return (
      <div className="excalidraw-error">
        <Icon name="pencil" size={36} />
        <strong>This drawing is not valid Excalidraw JSON.</strong>
        <span>Restore a previous version or rename the file to edit it as plain text.</span>
      </div>
    );
  }

  return (
    <div className="excalidraw-view">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(drawingApi) => { apiRef.current = drawingApi; }}
        onChange={onChange}
        name={(activePath?.split('/').pop() ?? 'Drawing').replace(/\.excalidraw$/i, '')}
        langCode="vi-VN"
        theme={theme}
        autoFocus
        detectScroll={false}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            toggleTheme: false,
          },
        }}
        renderTopRightUI={() => (
          <div className="wo-excalidraw-actions">
            <button type="button" title="Export PNG" onClick={() => void exportDrawing('png')}>
              <Icon name="image" size={15} />
              <span>PNG</span>
            </button>
            <button type="button" title="Export SVG" onClick={() => void exportDrawing('svg')}>
              <Icon name="file" size={15} />
              <span>SVG</span>
            </button>
          </div>
        )}
      />
    </div>
  );
}
