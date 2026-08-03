/**
 * Browser-side Obsidian community-plugin compatibility runtime.
 *
 * Community plugins are trusted code, just as they are in desktop Obsidian.
 * They execute in the WebObsidian origin and can use the authenticated vault
 * API. Desktop-only plugins (Node/Electron) are rejected before execution.
 */
import moment from 'moment';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { api, type TreeNode } from './api';
import { useStore } from './store';
import { getActiveEditor } from './activeEditor';
import { renderMarkdown } from './markdown';

type AnyFn = (...args: any[]) => any;

export interface PluginRuntimeState {
  id: string;
  name: string;
  status: 'disabled' | 'loading' | 'loaded' | 'incompatible' | 'failed';
  message?: string;
  loadedAt?: number;
}

export interface PluginCommandContribution {
  id: string;
  pluginId: string;
  pluginName: string;
  name: string;
  command: any;
}

export interface PluginDomContribution {
  id: string;
  pluginId: string;
  el: HTMLElement;
}

export interface PluginSettingContribution {
  id: string;
  pluginId: string;
  name: string;
  tab: PluginSettingTab;
}

export interface PluginRuntimeSnapshot {
  revision: number;
  plugins: Record<string, PluginRuntimeState>;
  commands: PluginCommandContribution[];
  ribbonItems: PluginDomContribution[];
  statusItems: PluginDomContribution[];
  settingTabs: PluginSettingContribution[];
}

const pluginStates = new Map<string, PluginRuntimeState>();
const commands = new Map<string, PluginCommandContribution>();
const ribbonItems = new Map<string, PluginDomContribution>();
const statusItems = new Map<string, PluginDomContribution>();
const settingTabs = new Map<string, PluginSettingContribution>();
const viewCreators = new Map<string, { pluginId: string; creator: (leaf: WorkspaceLeaf) => View }>();
const extensionViews = new Map<string, { pluginId: string; viewType: string }>();
const postProcessors = new Map<string, MarkdownProcessorRegistration>();
const iconRegistry = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;
let snapshot: PluginRuntimeSnapshot = buildSnapshot();
let contributionSeq = 0;

function buildSnapshot(): PluginRuntimeSnapshot {
  return {
    revision,
    plugins: Object.fromEntries(pluginStates),
    commands: [...commands.values()],
    ribbonItems: [...ribbonItems.values()],
    statusItems: [...statusItems.values()],
    settingTabs: [...settingTabs.values()],
  };
}

function changed(): void {
  revision += 1;
  snapshot = buildSnapshot();
  listeners.forEach((listener) => listener());
}

export function subscribePluginRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPluginRuntimeSnapshot(): PluginRuntimeSnapshot {
  return snapshot;
}

function setPluginState(state: PluginRuntimeState): void {
  pluginStates.set(state.id, state);
  changed();
}

function addContribution<T extends { id: string }>(map: Map<string, T>, item: T): () => void {
  map.set(item.id, item);
  changed();
  return () => {
    if (map.delete(item.id)) changed();
  };
}

function contributionId(pluginId: string, kind: string): string {
  contributionSeq += 1;
  return `${pluginId}:${kind}:${contributionSeq}`;
}

// ---- Obsidian DOM helpers -------------------------------------------------

let domHelpersInstalled = false;
function installDomHelpers(): void {
  if (domHelpersInstalled) return;
  domHelpersInstalled = true;
  const proto = HTMLElement.prototype as any;
  const svgProto = SVGElement.prototype as any;

  const create = function (this: HTMLElement, tag: string, options?: any): HTMLElement {
    const el = document.createElement(tag);
    applyDomOptions(el, options);
    this.appendChild(el);
    return el;
  };
  const createSvg = function (this: Element, tag: string, options?: any): SVGElement {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    applyDomOptions(el, options);
    this.appendChild(el);
    return el;
  };
  const methods: Record<string, AnyFn> = {
    createEl: create,
    createDiv(this: HTMLElement, options?: any) { return create.call(this, 'div', options); },
    createSpan(this: HTMLElement, options?: any) { return create.call(this, 'span', options); },
    createSvg,
    empty(this: Element) { this.replaceChildren(); return this; },
    setText(this: Element, text: unknown) { this.textContent = String(text ?? ''); return this; },
    addClass(this: Element, ...classes: string[]) { this.classList.add(...classes.flatMap(splitClasses)); return this; },
    removeClass(this: Element, ...classes: string[]) { this.classList.remove(...classes.flatMap(splitClasses)); return this; },
    toggleClass(this: Element, cls: string, value?: boolean) { this.classList.toggle(cls, value); return this; },
    hasClass(this: Element, cls: string) { return this.classList.contains(cls); },
    show(this: HTMLElement) { this.style.display = ''; return this; },
    hide(this: HTMLElement) { this.style.display = 'none'; return this; },
    detach(this: Element) { this.remove(); return this; },
    setAttr(this: Element, name: string, value: unknown) { this.setAttribute(name, String(value)); return this; },
    getAttr(this: Element, name: string) { return this.getAttribute(name); },
  };
  for (const [name, fn] of Object.entries(methods)) {
    if (!proto[name]) Object.defineProperty(proto, name, { value: fn, configurable: true });
    if (!svgProto[name]) Object.defineProperty(svgProto, name, { value: fn, configurable: true });
  }
}

function splitClasses(value: string): string[] {
  return String(value ?? '').split(/\s+/).filter(Boolean);
}

function applyDomOptions(el: Element, options?: any): void {
  if (typeof options === 'string') {
    el.classList.add(...splitClasses(options));
    return;
  }
  if (!options) return;
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : splitClasses(options.cls);
    el.classList.add(...classes);
  }
  if (options.text !== undefined) el.textContent = String(options.text);
  if (options.title !== undefined) el.setAttribute('title', String(options.title));
  if (options.href !== undefined) el.setAttribute('href', String(options.href));
  if (options.type !== undefined) el.setAttribute('type', String(options.type));
  if (options.value !== undefined && el instanceof HTMLInputElement) el.value = String(options.value);
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
}

function setNodeContent(el: HTMLElement, value: string | Node): void {
  el.replaceChildren();
  if (value instanceof Node) el.appendChild(value);
  else el.textContent = value;
}

// ---- Events + component lifecycle ----------------------------------------

export interface EventRef { off: () => void }

export class Events {
  private handlers = new Map<string, Set<{ callback: AnyFn; ctx?: unknown }>>();

  on(name: string, callback: AnyFn, ctx?: unknown): EventRef {
    const record = { callback, ctx };
    const group = this.handlers.get(name) ?? new Set();
    group.add(record);
    this.handlers.set(name, group);
    return { off: () => this.off(name, callback) };
  }

  off(name: string, callback: AnyFn): void {
    const group = this.handlers.get(name);
    if (!group) return;
    for (const record of group) if (record.callback === callback) group.delete(record);
    if (!group.size) this.handlers.delete(name);
  }

  offref(ref: EventRef): void { ref.off(); }

  trigger(name: string, ...args: unknown[]): void {
    for (const record of [...(this.handlers.get(name) ?? [])]) {
      try { record.callback.apply(record.ctx, args); }
      catch (error) { console.error(`[plugin:event:${name}]`, error); }
    }
  }
}

export abstract class Component {
  private cleanups: Array<() => void> = [];
  private children: Component[] = [];
  private loaded = false;

  register(callback: () => void): void { this.cleanups.push(callback); }
  registerEvent(ref: EventRef): void { this.register(() => ref?.off?.()); }
  registerDomEvent(el: EventTarget, type: string, callback: EventListenerOrEventListenerObject, options?: any): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }
  registerScope(_scope: unknown): void {}
  registerInterval(id: number): number { this.register(() => window.clearInterval(id)); return id; }
  addChild<T extends Component>(child: T): T { this.children.push(child); if (this.loaded) child.load(); return child; }
  removeChild<T extends Component>(child: T): T { this.children = this.children.filter((item) => item !== child); child.unload(); return child; }
  onload(): void {}
  onunload(): void {}
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    this.children.forEach((child) => child.load());
  }
  async loadAsync(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.onload();
    this.children.forEach((child) => child.load());
  }
  unload(): void {
    if (!this.loaded && !this.cleanups.length) return;
    this.children.splice(0).reverse().forEach((child) => child.unload());
    this.cleanups.splice(0).reverse().forEach((cleanup) => {
      try { cleanup(); } catch (error) { console.error('[plugin:cleanup]', error); }
    });
    this.onunload();
    this.loaded = false;
  }
}

// ---- Vault files + metadata ----------------------------------------------

export abstract class TAbstractFile {
  name: string;
  parent: TFolder | null = null;
  vault: Vault;
  constructor(public path: string, name?: string, vault?: Vault) {
    this.name = name ?? path.split('/').pop() ?? path;
    this.vault = vault ?? sharedApp?.vault;
  }
}

export class TFile extends TAbstractFile {
  stat: { ctime: number; mtime: number; size: number };
  constructor(path: string, name?: string, stat?: Partial<TFile['stat']>, vault?: Vault) {
    super(path, name, vault);
    this.stat = { ctime: stat?.ctime ?? 0, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0 };
  }
  get basename(): string { return this.name.replace(/\.[^.]+$/, ''); }
  get extension(): string { return this.name.includes('.') ? this.name.split('.').pop() ?? '' : ''; }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean { return !this.path; }
}

function buildAbstractTree(): TFolder {
  const tree = useStore.getState().tree;
  const root = new TFolder('', tree?.name ?? 'WebObsidian');
  const walk = (node: TreeNode, parent: TFolder): TAbstractFile => {
    if (node.type === 'folder') {
      const folder = new TFolder(node.path, node.name);
      folder.parent = parent;
      folder.children = (node.children ?? []).map((child) => walk(child, folder));
      return folder;
    }
    const file = new TFile(node.path, node.name, { ctime: node.ctime, mtime: node.mtime, size: node.size });
    file.parent = parent;
    return file;
  };
  root.children = (tree?.children ?? []).map((child) => walk(child, root));
  return root;
}

function flattenAbstract(root = buildAbstractTree()): TAbstractFile[] {
  const out: TAbstractFile[] = [root];
  const walk = (file: TAbstractFile) => {
    if (file instanceof TFolder) file.children.forEach((child) => { out.push(child); walk(child); });
  };
  walk(root);
  return out;
}

function abstractFile(path: string): TAbstractFile | null {
  const normalized = normalizePath(path);
  return flattenAbstract().find((file) => file.path === normalized) ?? null;
}

export class Vault extends Events {
  configDir = '.obsidian';
  adapter = new VaultAdapter(this);
  getName(): string { return useStore.getState().tree?.name ?? 'WebObsidian'; }
  getRoot(): TFolder { return buildAbstractTree(); }
  getFiles(): TFile[] { return flattenAbstract().filter((file): file is TFile => file instanceof TFile); }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter((file) => /^(md|markdown)$/i.test(file.extension)); }
  getAllLoadedFiles(): TAbstractFile[] { return flattenAbstract(); }
  getAbstractFileByPath(path: string): TAbstractFile | null { return abstractFile(path); }
  async read(file: TFile): Promise<string> { const result = await api.read(file.path); return result.content; }
  async cachedRead(file: TFile): Promise<string> { return this.read(file); }
  async readBinary(file: TFile): Promise<ArrayBuffer> { return api.readBinary(file.path); }
  getResourcePath(file: TFile): string { return api.rawUrl(file.path); }

  async create(path: string, data: string): Promise<TFile> {
    const normalized = normalizePath(path);
    await api.write(normalized, data);
    await useStore.getState().loadTree();
    const file = (abstractFile(normalized) as TFile | null) ?? new TFile(normalized);
    this.trigger('create', file);
    return file;
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(path);
    await api.writeBinary(normalized, data);
    await useStore.getState().loadTree();
    const file = (abstractFile(normalized) as TFile | null) ?? new TFile(normalized);
    this.trigger('create', file);
    return file;
  }
  async createFolder(path: string): Promise<TFolder> {
    const normalized = normalizePath(path);
    await api.createFolder(normalized);
    await useStore.getState().loadTree();
    const folder = (abstractFile(normalized) as TFolder | null) ?? new TFolder(normalized);
    this.trigger('create', folder);
    return folder;
  }
  async modify(file: TFile, data: string): Promise<void> {
    await api.write(file.path, data);
    this.trigger('modify', file);
    sharedApp.metadataCache.trigger('changed', file, data, getFileCacheFromText(file, data));
  }
  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    await api.writeBinary(file.path, data);
    this.trigger('modify', file);
  }
  async append(file: TFile, data: string): Promise<void> { await this.modify(file, (await this.read(file)) + data); }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(file));
    await this.modify(file, next);
    return next;
  }
  async delete(file: TAbstractFile): Promise<void> {
    await api.remove(file.path);
    await useStore.getState().loadTree();
    this.trigger('delete', file);
  }
  async trash(file: TAbstractFile): Promise<void> { return this.delete(file); }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    await api.rename(oldPath, normalizePath(newPath));
    file.path = normalizePath(newPath);
    file.name = file.path.split('/').pop() ?? file.path;
    await useStore.getState().loadTree();
    this.trigger('rename', file, oldPath);
  }
  async copy(file: TFile, newPath: string): Promise<TFile> {
    const normalized = normalizePath(newPath);
    await api.copy(file.path, normalized);
    await useStore.getState().loadTree();
    const copied = (abstractFile(normalized) as TFile | null) ?? new TFile(normalized);
    this.trigger('create', copied);
    return copied;
  }
}

class VaultAdapter {
  constructor(private vault: Vault) {}
  getName(): string { return this.vault.getName(); }
  getResourcePath(path: string): string { return api.rawUrl(path); }
  async exists(path: string): Promise<boolean> { return abstractFile(path) !== null; }
  async stat(path: string): Promise<any> { const file = abstractFile(path); return file instanceof TFile ? { type: 'file', ...file.stat } : file ? { type: 'folder', ctime: 0, mtime: 0, size: 0 } : null; }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const folder = abstractFile(path) as TFolder | null;
    return {
      files: folder?.children.filter((item): item is TFile => item instanceof TFile).map((item) => item.path) ?? [],
      folders: folder?.children.filter((item): item is TFolder => item instanceof TFolder).map((item) => item.path) ?? [],
    };
  }
  async read(path: string): Promise<string> { return this.vault.read(new TFile(path)); }
  async readBinary(path: string): Promise<ArrayBuffer> { return this.vault.readBinary(new TFile(path)); }
  async write(path: string, data: string): Promise<void> { await api.write(path, data); }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> { await api.writeBinary(path, data); }
  async append(path: string, data: string): Promise<void> { const file = new TFile(path); await this.vault.append(file, data); }
  async mkdir(path: string): Promise<void> { await api.createFolder(path); }
  async remove(path: string): Promise<void> { await api.remove(path); }
  async rename(from: string, to: string): Promise<void> { await api.rename(from, to); }
  async copy(from: string, to: string): Promise<void> { await api.copy(from, to); }
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  getFileCache(file: TFile): any {
    if (file.path === useStore.getState().activePath) return getFileCacheFromText(file, useStore.getState().content);
    return null;
  }
  getCache(path: string): any { const file = abstractFile(path); return file instanceof TFile ? this.getFileCache(file) : null; }
  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    const clean = linkpath.split('#')[0].toLowerCase();
    return sharedApp.vault.getFiles().find((file) => file.path.toLowerCase() === clean || file.basename.toLowerCase() === clean) ?? null;
  }
  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = false): string {
    return omitMdExtension && /^(md|markdown)$/i.test(file.extension) ? file.path.replace(/\.(md|markdown)$/i, '') : file.path;
  }
}

function getFileCacheFromText(_file: TFile, data: string): any {
  const frontmatterRaw = data.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  let frontmatter: any;
  try { frontmatter = frontmatterRaw ? parseYaml(frontmatterRaw) : undefined; } catch { frontmatter = undefined; }
  const headings = [...data.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({ heading: match[2], level: match[1].length, position: null }));
  const tags = [...data.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)].map((match) => ({ tag: match[2], position: null }));
  const links = [...data.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => ({ link: match[1].trim(), original: match[0], displayText: match[1].trim(), position: null }));
  const embeds = [...data.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => ({ link: match[1].trim(), original: match[0], displayText: match[1].trim(), position: null }));
  return { frontmatter, headings, tags, links, embeds };
}

// ---- Editor + workspace views --------------------------------------------

export class Editor {
  private view() { return getActiveEditor(); }
  getValue(): string { return this.view()?.state.doc.toString() ?? ''; }
  setValue(value: string): void { const view = this.view(); if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }
  getSelection(): string { const view = this.view(); if (!view) return ''; const { from, to } = view.state.selection.main; return view.state.sliceDoc(from, to); }
  replaceSelection(value: string): void { const view = this.view(); if (!view) return; const { from, to } = view.state.selection.main; view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length } }); }
  getCursor(which: 'from' | 'to' | 'head' | 'anchor' = 'head'): { line: number; ch: number } {
    const view = this.view(); if (!view) return { line: 0, ch: 0 };
    const selection = view.state.selection.main;
    const offset = which === 'from' ? selection.from : which === 'to' ? selection.to : which === 'anchor' ? selection.anchor : selection.head;
    return this.offsetToPos(offset);
  }
  setCursor(pos: { line: number; ch: number }): void { const view = this.view(); if (view) view.dispatch({ selection: { anchor: this.posToOffset(pos) } }); }
  setSelection(anchor: { line: number; ch: number }, head?: { line: number; ch: number }): void { const view = this.view(); if (view) view.dispatch({ selection: { anchor: this.posToOffset(anchor), head: this.posToOffset(head ?? anchor) } }); }
  getLine(line: number): string { const view = this.view(); if (!view || line < 0 || line >= view.state.doc.lines) return ''; return view.state.doc.line(line + 1).text; }
  lineCount(): number { return this.view()?.state.doc.lines ?? 0; }
  lastLine(): number { return Math.max(0, this.lineCount() - 1); }
  replaceRange(value: string, from: { line: number; ch: number }, to = from): void { const view = this.view(); if (view) view.dispatch({ changes: { from: this.posToOffset(from), to: this.posToOffset(to), insert: value } }); }
  posToOffset(pos: { line: number; ch: number }): number { const view = this.view(); if (!view) return 0; const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, pos.line + 1))); return Math.min(line.to, line.from + Math.max(0, pos.ch)); }
  offsetToPos(offset: number): { line: number; ch: number } { const view = this.view(); if (!view) return { line: 0, ch: 0 }; const line = view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length))); return { line: line.number - 1, ch: offset - line.from }; }
  focus(): void { this.view()?.focus(); }
  hasFocus(): boolean { return this.view()?.hasFocus ?? false; }
  somethingSelected(): boolean { const selection = this.view()?.state.selection.main; return Boolean(selection && !selection.empty); }
}

export class WorkspaceLeaf extends Events {
  readonly id = contributionId('workspace', 'leaf');
  view: View;
  private state: any = { type: 'empty', state: {} };
  constructor() { super(); this.view = new EmptyView(this); }
  async openFile(file: TFile): Promise<void> { await useStore.getState().openFile(file.path); }
  async open(view: View): Promise<View> { await this.view.onClose(); this.view = view; await view.onOpen(); return view; }
  getViewState(): any { return this.state; }
  async setViewState(state: any): Promise<void> {
    this.state = state;
    const registered = viewCreators.get(state.type);
    if (!registered) throw new Error(`No view registered for type: ${state.type}`);
    await this.view.onClose();
    this.view = registered.creator(this);
    await this.view.setState(state.state ?? {}, {});
    await this.view.onOpen();
    const path = `${PLUGIN_VIEW_PREFIX}${encodeURIComponent(state.type)}/${this.id}`;
    activeViews.set(path, this);
    await useStore.getState().openFile(path);
    const title = this.view.getDisplayText();
    useStore.setState((current) => ({ tabs: current.tabs.map((tab) => tab.path === path ? { ...tab, title } : tab) }));
  }
  async loadIfDeferred(): Promise<void> {}
  get isDeferred(): boolean { return false; }
  getEphemeralState(): any { return {}; }
  setEphemeralState(_state: any): void {}
  togglePinned(): void {}
  setPinned(_pinned: boolean): void {}
  setGroupMember(_other: WorkspaceLeaf): void {}
  setGroup(_group: string): void {}
  detach(): void { const entry = [...activeViews].find(([, leaf]) => leaf === this); if (entry) { void this.view.onClose(); activeViews.delete(entry[0]); useStore.getState().closeTab(entry[0]); } }
  getIcon(): string { return this.view.getIcon(); }
  getDisplayText(): string { return this.view.getDisplayText(); }
  onResize(): void { this.view.onResize(); }
}

export class View extends Component {
  containerEl: HTMLElement;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'workspace-leaf-content plugin-view-content';
  }
  getViewType(): string { return 'empty'; }
  getDisplayText(): string { return this.getViewType(); }
  getIcon(): string { return 'file'; }
  getState(): any { return {}; }
  async setState(_state: any, _result: any): Promise<void> {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> { this.unload(); }
  onResize(): void {}
  get navigation(): boolean { return true; }
}

class EmptyView extends View { getViewType(): string { return 'empty'; } getDisplayText(): string { return 'Empty'; } }

export class ItemView extends View {
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'view-content';
    this.containerEl.appendChild(this.contentEl);
  }
}

export class FileView extends ItemView { file: TFile | null = null; }
export class TextFileView extends FileView {
  data = '';
  getViewData(): string { return this.data; }
  setViewData(data: string, _clear: boolean): void { this.data = data; }
  clear(): void { this.data = ''; }
  async save(): Promise<void> { if (this.file) await sharedApp.vault.modify(this.file, this.getViewData()); }
  async onLoadFile(file: TFile): Promise<void> { this.file = file; this.setViewData(await sharedApp.vault.read(file), true); }
  async onUnloadFile(_file: TFile): Promise<void> {}
}

export class MarkdownView extends TextFileView {
  editor = new Editor();
  getViewType(): string { return 'markdown'; }
  getDisplayText(): string { return this.file?.basename ?? 'Markdown'; }
}
export class MarkdownPreviewView extends MarkdownView {}

const PLUGIN_VIEW_PREFIX = 'plugin-view://';
const activeViews = new Map<string, WorkspaceLeaf>();

export function isPluginViewPath(path: string | null): boolean {
  if (!path) return false;
  if (path.startsWith(PLUGIN_VIEW_PREFIX)) return true;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return extensionViews.has(ext);
}

export async function ensurePluginViewForPath(path: string): Promise<View | null> {
  const existing = activeViews.get(path);
  if (existing) return existing.view;
  const customType = path.startsWith(PLUGIN_VIEW_PREFIX)
    ? decodeURIComponent(path.slice(PLUGIN_VIEW_PREFIX.length).split('/')[0] ?? '')
    : '';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const viewType = customType || extensionViews.get(ext)?.viewType;
  if (!viewType) return null;
  const creator = viewCreators.get(viewType);
  if (!creator) return null;
  const leaf = new WorkspaceLeaf();
  const view = creator.creator(leaf);
  leaf.view = view;
  const file = customType ? null : abstractFile(path);
  if (view instanceof FileView && file instanceof TFile) view.file = file;
  if (file instanceof TFile && typeof (view as any).onLoadFile === 'function') await (view as any).onLoadFile(file);
  if (customType) await view.setState({}, {});
  await view.onOpen();
  activeViews.set(path, leaf);
  return view;
}

export class Workspace extends Events {
  layoutReady = true;
  containerEl = document.body;
  activeEditor: any = null;
  onLayoutReady(callback: () => any): void { queueMicrotask(callback); }
  getActiveFile(): TFile | null { const path = useStore.getState().activePath; const file = path ? abstractFile(path) : null; return file instanceof TFile ? file : null; }
  get activeLeaf(): WorkspaceLeaf | null {
    const path = useStore.getState().activePath;
    if (path && activeViews.has(path)) return activeViews.get(path)!;
    const leaf = new WorkspaceLeaf();
    if (path && /\.(md|markdown)$/i.test(path)) { const view = new MarkdownView(leaf); view.file = this.getActiveFile(); leaf.view = view; }
    return leaf;
  }
  getLeaf(_newLeaf?: any): WorkspaceLeaf { return this.activeLeaf ?? new WorkspaceLeaf(); }
  getLeftLeaf(_split: boolean): WorkspaceLeaf { return this.getLeaf(); }
  getRightLeaf(_split: boolean): WorkspaceLeaf { return this.getLeaf(); }
  async openLinkText(linktext: string, _sourcePath: string, _newLeaf?: any): Promise<void> { await useStore.getState().openWikilink(linktext); }
  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null { const view = this.activeLeaf?.view; return view instanceof type ? view : null; }
  getLeavesOfType(type: string): WorkspaceLeaf[] { return [...activeViews.values()].filter((leaf) => leaf.view.getViewType() === type); }
  detachLeavesOfType(type: string): void { this.getLeavesOfType(type).forEach((leaf) => leaf.detach()); }
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => any): void { const leaf = this.activeLeaf; if (leaf) callback(leaf); }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => any): void { this.iterateRootLeaves(callback); }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> { const entry = [...activeViews].find(([, item]) => item === leaf); if (entry) await useStore.getState().openFile(entry[0]); }
  setActiveLeaf(leaf: WorkspaceLeaf): void { void this.revealLeaf(leaf); }
  getLastOpenFiles(): string[] { return useStore.getState().recent.slice(0, 10); }
  updateOptions(): void { this.trigger('css-change'); }
}

export class FileManager {
  constructor(private app: App) {}
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> { await this.app.vault.rename(file, newPath); }
  async trashFile(file: TAbstractFile): Promise<void> { await this.app.vault.trash(file); }
  generateMarkdownLink(file: TFile, _sourcePath: string, subpath = '', alias = ''): string {
    const target = file.path.replace(/\.(md|markdown)$/i, '') + subpath;
    return `[[${target}${alias ? `|${alias}` : ''}]]`;
  }
  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void> {
    await this.app.vault.process(file, (data) => {
      const match = data.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      let frontmatter: any = {};
      try { frontmatter = match ? parseYaml(match[1]) ?? {} : {}; } catch { frontmatter = {}; }
      fn(frontmatter);
      const yaml = stringifyYaml(frontmatter).trimEnd();
      return `---\n${yaml}\n---\n${match ? data.slice(match[0].length) : data}`;
    });
  }
}

// ---- UI components exposed to plugins ------------------------------------

export class Notice {
  noticeEl: HTMLElement;
  constructor(message: string | DocumentFragment, timeout = 4000) {
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'toast plugin-notice';
    if (typeof message === 'string') this.noticeEl.textContent = message;
    else this.noticeEl.appendChild(message);
    document.body.appendChild(this.noticeEl);
    if (timeout > 0) window.setTimeout(() => this.hide(), timeout);
  }
  setMessage(message: string | DocumentFragment): this { setNodeContent(this.noticeEl, message); return this; }
  hide(): void { this.noticeEl.remove(); }
}

export class Modal {
  containerEl = document.createElement('div');
  modalEl = document.createElement('div');
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  scope = new Scope();
  constructor(public app: App) {
    this.containerEl.className = 'modal-bg plugin-modal-bg';
    this.modalEl.className = 'modal plugin-modal';
    this.titleEl.className = 'modal-title';
    this.contentEl.className = 'modal-content';
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.containerEl.addEventListener('mousedown', (event) => { if (event.target === this.containerEl) this.close(); });
  }
  setTitle(title: string): this { this.titleEl.textContent = title; return this; }
  setContent(content: string | DocumentFragment): this { setNodeContent(this.contentEl, content); return this; }
  open(): void { document.body.appendChild(this.containerEl); this.scope.activate(); this.onOpen(); }
  close(): void { this.onClose(); this.scope.deactivate(); this.containerEl.remove(); }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  inputEl = document.createElement('input');
  resultContainerEl = document.createElement('div');
  emptyStateText = 'No matches found';
  limit = 100;
  constructor(app: App) {
    super(app);
    this.inputEl.className = 'palette-input';
    this.resultContainerEl.className = 'palette-list';
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    this.inputEl.addEventListener('input', () => void this.refresh());
  }
  setPlaceholder(value: string): void { this.inputEl.placeholder = value; }
  setInstructions(_instructions: any[]): void {}
  getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
  renderSuggestion(value: T, el: HTMLElement): void { el.textContent = this.getItemText(value); }
  getItemText(value: T): string { return String(value); }
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  selectSuggestion(_value: any, _evt: any): void {}
  override open(): void { super.open(); void this.refresh(); this.inputEl.focus(); }
  private async refresh(): Promise<void> {
    const values = (await this.getSuggestions(this.inputEl.value)).slice(0, this.limit);
    this.resultContainerEl.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-item';
      empty.textContent = this.emptyStateText;
      this.resultContainerEl.appendChild(empty);
      return;
    }
    for (const value of values) {
      const row = document.createElement('div');
      row.className = 'palette-item';
      this.renderSuggestion(value, row);
      row.addEventListener('click', (event) => { this.onChooseSuggestion(value, event); this.close(); });
      this.resultContainerEl.appendChild(row);
    }
  }
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {
  getItems(): T[] { return []; }
  override getSuggestions(query: string): T[] { const lower = query.toLowerCase(); return this.getItems().filter((item) => this.getItemText(item).toLowerCase().includes(lower)); }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  override onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void { this.onChooseItem(item, evt); }
}

export class MenuItem {
  title = '';
  icon = '';
  disabled = false;
  checked = false;
  separator = false;
  callback?: () => void;
  setTitle(title: string | DocumentFragment): this { this.title = typeof title === 'string' ? title : title.textContent ?? ''; return this; }
  setIcon(icon: string | null): this { this.icon = icon ?? ''; return this; }
  setDisabled(value: boolean): this { this.disabled = value; return this; }
  setChecked(value: boolean): this { this.checked = value; return this; }
  setSection(_section: string): this { return this; }
  onClick(callback: () => void): this { this.callback = callback; return this; }
  setSubmenu(): Menu { return new Menu(); }
}

export class Menu {
  items: MenuItem[] = [];
  addItem(callback: (item: MenuItem) => any): this { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
  addSeparator(): this { const item = new MenuItem(); item.separator = true; this.items.push(item); return this; }
  showAtMouseEvent(event: MouseEvent): this { return this.showAtPosition({ x: event.clientX, y: event.clientY }); }
  showAtPosition(position: { x: number; y: number }): this {
    useStore.getState().openContextMenu({
      ...position,
      items: this.items.map((item) => item.separator ? { label: '', separator: true } : { label: item.title, icon: item.icon, onClick: item.disabled ? undefined : item.callback }),
    });
    return this;
  }
  hide(): this { useStore.getState().closeContextMenu(); return this; }
}

abstract class ValueComponent<T> {
  disabled = false;
  constructor(public containerEl: HTMLElement) {}
  setDisabled(value: boolean): this { this.disabled = value; return this; }
  then(callback: (component: this) => any): this { callback(this); return this; }
}

export class TextComponent extends ValueComponent<string> {
  inputEl = document.createElement('input');
  constructor(containerEl: HTMLElement) { super(containerEl); this.inputEl.className = 'text-input'; containerEl.appendChild(this.inputEl); }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => any): this { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
  override setDisabled(value: boolean): this { super.setDisabled(value); this.inputEl.disabled = value; return this; }
}
export class SearchComponent extends TextComponent { constructor(containerEl: HTMLElement) { super(containerEl); this.inputEl.type = 'search'; } }
export class TextAreaComponent extends ValueComponent<string> {
  inputEl = document.createElement('textarea');
  constructor(containerEl: HTMLElement) { super(containerEl); this.inputEl.className = 'text-input'; containerEl.appendChild(this.inputEl); }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => any): this { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
  override setDisabled(value: boolean): this { super.setDisabled(value); this.inputEl.disabled = value; return this; }
}
export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl = document.createElement('input');
  constructor(containerEl: HTMLElement) { super(containerEl); this.toggleEl.type = 'checkbox'; containerEl.appendChild(this.toggleEl); }
  getValue(): boolean { return this.toggleEl.checked; }
  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  onChange(callback: (value: boolean) => any): this { this.toggleEl.addEventListener('change', () => callback(this.toggleEl.checked)); return this; }
  override setDisabled(value: boolean): this { super.setDisabled(value); this.toggleEl.disabled = value; return this; }
}
export class DropdownComponent extends ValueComponent<string> {
  selectEl = document.createElement('select');
  constructor(containerEl: HTMLElement) { super(containerEl); this.selectEl.className = 'text-input'; containerEl.appendChild(this.selectEl); }
  addOption(value: string, display: string): this { this.selectEl.add(new Option(display, value)); return this; }
  addOptions(options: Record<string, string>): this { Object.entries(options).forEach(([value, display]) => this.addOption(value, display)); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => any): this { this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this; }
  override setDisabled(value: boolean): this { super.setDisabled(value); this.selectEl.disabled = value; return this; }
}
export class ButtonComponent extends ValueComponent<never> {
  buttonEl = document.createElement('button');
  constructor(containerEl: HTMLElement) { super(containerEl); this.buttonEl.className = 'btn secondary'; containerEl.appendChild(this.buttonEl); }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
  setTooltip(value: string): this { this.buttonEl.title = value; return this; }
  setClass(value: string): this { this.buttonEl.classList.add(value); return this; }
  setCta(): this { this.buttonEl.classList.remove('secondary'); return this; }
  setWarning(): this { this.buttonEl.classList.add('danger'); return this; }
  onClick(callback: (event: MouseEvent) => any): this { this.buttonEl.addEventListener('click', callback); return this; }
  override setDisabled(value: boolean): this { super.setDisabled(value); this.buttonEl.disabled = value; return this; }
}
export class ExtraButtonComponent extends ButtonComponent {}
export class SliderComponent extends ValueComponent<number> {
  sliderEl = document.createElement('input');
  constructor(containerEl: HTMLElement) { super(containerEl); this.sliderEl.type = 'range'; containerEl.appendChild(this.sliderEl); }
  getValue(): number { return Number(this.sliderEl.value); }
  setValue(value: number): this { this.sliderEl.value = String(value); return this; }
  setLimits(min: number, max: number, step: number | 'any'): this { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
  setDynamicTooltip(): this { return this; }
  onChange(callback: (value: number) => any): this { this.sliderEl.addEventListener('input', () => callback(this.getValue())); return this; }
}
export class ColorComponent extends ValueComponent<string> {
  colorPickerEl = document.createElement('input');
  constructor(containerEl: HTMLElement) { super(containerEl); this.colorPickerEl.type = 'color'; containerEl.appendChild(this.colorPickerEl); }
  getValue(): string { return this.colorPickerEl.value; }
  setValue(value: string): this { this.colorPickerEl.value = value; return this; }
  onChange(callback: (value: string) => any): this { this.colorPickerEl.addEventListener('input', () => callback(this.getValue())); return this; }
}

export class Setting {
  settingEl = document.createElement('div');
  infoEl = document.createElement('div');
  nameEl = document.createElement('div');
  descEl = document.createElement('div');
  controlEl = document.createElement('div');
  components: any[] = [];
  errorEl: HTMLElement | null = null;
  constructor(containerEl: HTMLElement) {
    this.settingEl.className = 'setting-row setting-item';
    this.infoEl.className = 'info setting-item-info';
    this.nameEl.className = 'name setting-item-name';
    this.descEl.className = 'desc setting-item-description';
    this.controlEl.className = 'control setting-item-control';
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }
  setName(value: string | DocumentFragment): this { setNodeContent(this.nameEl, value); return this; }
  setDesc(value: string | DocumentFragment): this { setNodeContent(this.descEl, value); return this; }
  setClass(value: string): this { this.settingEl.classList.add(value); return this; }
  setTooltip(value: string): this { this.settingEl.title = value; return this; }
  setErrorMessage(value: string | null): this {
    this.errorEl?.remove();
    this.errorEl = null;
    this.settingEl.classList.toggle('is-invalid', Boolean(value));
    if (value) { this.errorEl = document.createElement('div'); this.errorEl.className = 'setting-item-error'; this.errorEl.textContent = value; this.infoEl.appendChild(this.errorEl); }
    return this;
  }
  setHeading(): this { this.settingEl.classList.add('setting-item-heading'); return this; }
  setDisabled(value: boolean): this { this.controlEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select,textarea').forEach((el) => { el.disabled = value; }); return this; }
  addText(callback: (component: TextComponent) => any): this { return this.add(TextComponent, callback); }
  addSearch(callback: (component: SearchComponent) => any): this { return this.add(SearchComponent, callback); }
  addTextArea(callback: (component: TextAreaComponent) => any): this { return this.add(TextAreaComponent, callback); }
  addMomentFormat(callback: (component: TextComponent) => any): this { return this.add(TextComponent, callback); }
  addToggle(callback: (component: ToggleComponent) => any): this { return this.add(ToggleComponent, callback); }
  addButton(callback: (component: ButtonComponent) => any): this { return this.add(ButtonComponent, callback); }
  addExtraButton(callback: (component: ExtraButtonComponent) => any): this { return this.add(ExtraButtonComponent, callback); }
  addDropdown(callback: (component: DropdownComponent) => any): this { return this.add(DropdownComponent, callback); }
  addSlider(callback: (component: SliderComponent) => any): this { return this.add(SliderComponent, callback); }
  addColorPicker(callback: (component: ColorComponent) => any): this { return this.add(ColorComponent, callback); }
  addComponent<T>(callback: (el: HTMLElement) => T): this { this.components.push(callback(this.controlEl)); return this; }
  then(callback: (setting: this) => any): this { callback(this); return this; }
  clear(): this { this.settingEl.replaceChildren(); return this; }
  private add<T>(Ctor: new (el: HTMLElement) => T, callback: (component: T) => any): this { const component = new Ctor(this.controlEl); this.components.push(component); callback(component); return this; }
}

export class PluginSettingTab {
  id: string;
  name: string;
  containerEl = document.createElement('div');
  constructor(public app: App, public plugin: Plugin) { this.id = plugin.manifest.id; this.name = plugin.manifest.name; this.containerEl.className = 'plugin-setting-tab'; }
  display(): void {}
  hide(): void {}
}

// ---- Markdown processing --------------------------------------------------

interface MarkdownProcessorRegistration {
  id: string;
  pluginId: string;
  sortOrder: number;
  processor?: AnyFn;
  language?: string;
  handler?: AnyFn;
}

export class MarkdownRenderChild extends Component { constructor(public containerEl: HTMLElement) { super(); } }

function markdownContext(sourcePath: string, children: Component[]) {
  return {
    sourcePath,
    frontmatter: undefined,
    docId: sourcePath,
    addChild(child: Component) { children.push(child); child.load(); },
    getSectionInfo(_el: HTMLElement) { return null; },
  };
}

export async function runMarkdownPostProcessors(root: HTMLElement, sourcePath: string): Promise<() => void> {
  const children: Component[] = [];
  const registrations = [...postProcessors.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const registration of registrations) {
    const ctx = markdownContext(sourcePath, children);
    try {
      if (registration.language && registration.handler) {
        const selector = `pre > code.language-${CSS.escape(registration.language)}`;
        for (const code of [...root.querySelectorAll<HTMLElement>(selector)]) {
          const pre = code.parentElement;
          if (!pre) continue;
          const el = document.createElement('div');
          el.className = `block-language-${registration.language}`;
          pre.replaceWith(el);
          await registration.handler(code.textContent ?? '', el, ctx);
        }
      } else if (registration.processor) {
        await registration.processor(root, ctx);
      }
    } catch (error) {
      console.error(`[plugin:${registration.pluginId}] Markdown processor failed`, error);
    }
  }
  return () => children.splice(0).reverse().forEach((child) => child.unload());
}

export class MarkdownRenderer {
  static async render(_app: App, markdown: string, el: HTMLElement, sourcePath: string, _component: Component): Promise<void> {
    el.innerHTML = await renderMarkdown(markdown, { rawUrl: (path) => api.rawUrl(path) });
    const cleanup = await runMarkdownPostProcessors(el, sourcePath);
    _component.register(cleanup);
  }
  static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> { return this.render(sharedApp, markdown, el, sourcePath, component); }
}

// ---- Plugin base + app ----------------------------------------------------

export abstract class Plugin extends Component {
  app: App;
  manifest: any;
  constructor(app: App, manifest: any) { super(); this.app = app; this.manifest = manifest; }
  abstract onload(): void | Promise<void>;
  onunload(): void {}
  addCommand(command: any): any {
    const id = command.id.includes(':') ? command.id : `${this.manifest.id}:${command.id}`;
    const contribution = { id, pluginId: this.manifest.id, pluginName: this.manifest.name, name: command.name, command };
    this.register(addContribution(commands, contribution));
    return command;
  }
  removeCommand(commandId: string): void { const full = commandId.includes(':') ? commandId : `${this.manifest.id}:${commandId}`; if (commands.delete(full)) changed(); }
  addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => any): HTMLElement {
    const el = document.createElement('button');
    el.className = 'clickable-icon plugin-ribbon-button';
    el.title = title;
    setIcon(el, icon);
    el.addEventListener('click', callback);
    const item = { id: contributionId(this.manifest.id, 'ribbon'), pluginId: this.manifest.id, el };
    this.register(addContribution(ribbonItems, item));
    return el;
  }
  addStatusBarItem(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'status-bar-item plugin-status-bar-item';
    const item = { id: contributionId(this.manifest.id, 'status'), pluginId: this.manifest.id, el };
    this.register(addContribution(statusItems, item));
    return el;
  }
  addSettingTab(tab: PluginSettingTab): void {
    const item = { id: `${this.manifest.id}:${tab.id || 'settings'}`, pluginId: this.manifest.id, name: tab.name || this.manifest.name, tab };
    this.register(addContribution(settingTabs, item));
  }
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    if (viewCreators.has(type)) throw new Error(`View type already registered: ${type}`);
    viewCreators.set(type, { pluginId: this.manifest.id, creator });
    changed();
    this.register(() => { viewCreators.delete(type); sharedApp.workspace.detachLeavesOfType(type); changed(); });
  }
  registerExtensions(extensions: string[], viewType: string): void {
    for (const extension of extensions) extensionViews.set(extension.replace(/^\./, '').toLowerCase(), { pluginId: this.manifest.id, viewType });
    changed();
    this.register(() => { for (const [extension, entry] of extensionViews) if (entry.pluginId === this.manifest.id && entry.viewType === viewType) extensionViews.delete(extension); changed(); });
  }
  registerMarkdownPostProcessor(processor: AnyFn, sortOrder = 0): AnyFn {
    const item = { id: contributionId(this.manifest.id, 'markdown'), pluginId: this.manifest.id, sortOrder, processor };
    this.register(addContribution(postProcessors, item));
    return processor;
  }
  registerMarkdownCodeBlockProcessor(language: string, handler: AnyFn, sortOrder = 0): AnyFn {
    const item = { id: contributionId(this.manifest.id, 'codeblock'), pluginId: this.manifest.id, sortOrder, language, handler };
    this.register(addContribution(postProcessors, item));
    return handler;
  }
  registerEditorExtension(_extension: unknown): void { compatibilityWarning(this.manifest.id, 'CodeMirror editor extensions are not yet mounted'); }
  registerEditorSuggest(_suggest: unknown): void { compatibilityWarning(this.manifest.id, 'EditorSuggest is not yet mounted'); }
  registerHoverLinkSource(_id: string, _info: unknown): void {}
  registerObsidianProtocolHandler(_action: string, _handler: AnyFn): void {}
  async loadData(): Promise<any> { return (await api.getPluginData(this.manifest.id)).data; }
  async saveData(data: unknown): Promise<void> { await api.putPluginData(this.manifest.id, data); }
  onUserEnable(): void {}
}

export class App {
  vault = new Vault();
  workspace = new Workspace();
  metadataCache = new MetadataCache();
  fileManager = new FileManager(this);
  keymap = {};
  scope = {};
  setting = {
    open: () => useStore.getState().setSettings(true),
    openTabById: (_id: string) => useStore.getState().setSettings(true),
  };
  commands = {
    listCommands: () => [...commands.values()].map((entry) => ({ id: entry.id, name: entry.name })),
    executeCommandById: (id: string) => runPluginCommand(id),
    findCommand: (id: string) => commands.get(id)?.command,
  };
  plugins = {
    enabledPlugins: new Set<string>(),
    getPlugin: (id: string) => loaded.get(id)?.instance,
  };
}

const sharedApp = new App();

// ---- Icons + utilities ----------------------------------------------------

export function addIcon(iconId: string, svgContent: string): void { iconRegistry.set(iconId, svgContent); }
export function removeIcon(iconId: string): void { iconRegistry.delete(iconId); }
export function getIcon(iconId: string): SVGSVGElement | null {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.innerHTML = iconRegistry.get(iconId) ?? '<circle cx="50" cy="50" r="34"/><path d="M50 28v44M28 50h44"/>';
  return svg;
}
export function setIcon(parent: HTMLElement, iconId: string): void { parent.replaceChildren(getIcon(iconId)!); parent.dataset.icon = iconId; }
export function normalizePath(path: string): string { return path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/'); }
export function getLinkpath(linktext: string): string { return linktext.split('#')[0]; }
export function parseLinktext(linktext: string): { path: string; subpath: string } { const index = linktext.search(/[#^]/); return index < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, index), subpath: linktext.slice(index) }; }
export function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
export function debounce<T extends AnyFn>(callback: T, timeout = 0, resetTimer = true): T {
  let timer: number | undefined;
  return function (this: unknown, ...args: any[]) {
    if (resetTimer) window.clearTimeout(timer);
    if (!timer || resetTimer) timer = window.setTimeout(() => { timer = undefined; callback.apply(this, args); }, timeout);
  } as T;
}
export class Scope {
  private handlers: Array<{ modifiers: string[]; key: string; callback: AnyFn }> = [];
  private active = false;
  private listener = (event: KeyboardEvent) => {
    for (const handler of this.handlers) {
      if (!hotkeyMatches(event, { modifiers: handler.modifiers, key: handler.key })) continue;
      const result = handler.callback(event);
      if (result !== false) { event.preventDefault(); event.stopPropagation(); }
      break;
    }
  };
  register(modifiers: string[], key: string, callback: AnyFn): any { const handler = { modifiers, key, callback }; this.handlers.push(handler); return handler; }
  unregister(handler: any): void { this.handlers = this.handlers.filter((item) => item !== handler); }
  activate(): void { if (!this.active) { window.addEventListener('keydown', this.listener, true); this.active = true; } }
  deactivate(): void { if (this.active) { window.removeEventListener('keydown', this.listener, true); this.active = false; } }
}
export const Keymap = {
  isModEvent(event: KeyboardEvent | MouseEvent): boolean { return Platform.isMacOS ? event.metaKey : event.ctrlKey; },
  isModifier(modifier: string): boolean { return ['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'].includes(modifier); },
};
export const apiVersion = '1.0.0';
export function requireApiVersion(version: string): boolean {
  const parse = (value: string) => value.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const current = parse(apiVersion);
  const requested = parse(version);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== requested[index]) return current[index] > requested[index];
  }
  return true;
}
export function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: any, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyDomOptions(el, options);
  callback?.(el);
  return el;
}
export function createDiv(options?: any, callback?: (el: HTMLDivElement) => void): HTMLDivElement { return createEl('div', options, callback); }
export function createSpan(options?: any, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement { return createEl('span', options, callback); }
export function createFragment(callback?: (fragment: DocumentFragment) => void): DocumentFragment { const fragment = document.createDocumentFragment(); callback?.(fragment); return fragment; }
export function setTooltip(el: HTMLElement, tooltip: string | DocumentFragment): void { el.title = typeof tooltip === 'string' ? tooltip : tooltip.textContent ?? ''; }
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  template.content.querySelectorAll<HTMLElement>('*').forEach((node) => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^javascript:/i.test(attr.value.trim()))) node.removeAttribute(attr.name);
    }
  });
  return template.content;
}
export function getAllTags(cache: any): string[] | null {
  if (!cache) return null;
  const tags = new Set<string>((cache.tags ?? []).map((entry: any) => String(entry.tag)));
  const frontmatterTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
  const values = Array.isArray(frontmatterTags) ? frontmatterTags : frontmatterTags ? [frontmatterTags] : [];
  values.flatMap((value: unknown) => String(value).split(/[,\s]+/)).filter(Boolean).forEach((tag: string) => tags.add(tag.startsWith('#') ? tag : `#${tag}`));
  return [...tags];
}
export function parseFrontMatterAliases(frontmatter: any): string[] | null { const value = frontmatter?.aliases ?? frontmatter?.alias; return value == null ? null : (Array.isArray(value) ? value : [value]).map(String); }
export function parseFrontMatterTags(frontmatter: any): string[] | null { const value = frontmatter?.tags ?? frontmatter?.tag; return value == null ? null : (Array.isArray(value) ? value : String(value).split(/[,\s]+/)).map(String); }
export function getFrontMatterInfo(content: string): any {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  return match
    ? { exists: true, frontmatter: match[1], from: 0, to: match[0].length, contentStart: match[0].length }
    : { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
}
export async function requestUrl(params: string | any): Promise<any> {
  const options = typeof params === 'string' ? { url: params } : params;
  const response = await fetch(options.url, { method: options.method ?? 'GET', headers: options.headers, body: options.body, credentials: 'omit' });
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer, text, json };
}
export async function request(params: string | any): Promise<string> { return (await requestUrl(params)).text; }

const Platform = {
  isDesktop: !matchMedia('(max-width: 700px)').matches,
  isMobile: matchMedia('(max-width: 700px)').matches,
  isDesktopApp: false,
  isMobileApp: false,
  isIosApp: /iPad|iPhone|iPod/.test(navigator.userAgent),
  isAndroidApp: /Android/.test(navigator.userAgent),
  isPhone: matchMedia('(max-width: 700px)').matches,
  isTablet: matchMedia('(min-width: 701px) and (max-width: 1100px)').matches,
  isMacOS: /Mac/.test(navigator.platform),
  isWin: /Win/.test(navigator.platform),
  isLinux: /Linux/.test(navigator.platform),
  isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
  resourcePathPrefix: `${location.origin}/api/files/content?path=`,
};

const obsidianModule: Record<string, any> = {
  App, Plugin, Component, Events, Notice, Modal, SuggestModal, FuzzySuggestModal,
  Menu, MenuItem, Setting, PluginSettingTab,
  TextComponent, TextAreaComponent, SearchComponent, ToggleComponent,
  DropdownComponent, ButtonComponent, ExtraButtonComponent, SliderComponent, ColorComponent,
  TAbstractFile, TFile, TFolder, Vault, MetadataCache, Workspace, WorkspaceLeaf,
  View, ItemView, FileView, TextFileView, MarkdownView, MarkdownPreviewView, Editor, FileManager,
  MarkdownRenderer, MarkdownRenderChild,
  Platform, Keymap, Scope, moment, apiVersion, parseYaml, stringifyYaml,
  addIcon, removeIcon, getIcon, setIcon, normalizePath, getLinkpath, parseLinktext,
  clamp, debounce, requireApiVersion, request, requestUrl,
  createEl, createDiv, createSpan, createFragment, setTooltip, sanitizeHTMLToDom,
  getAllTags, parseFrontMatterAliases, parseFrontMatterTags, getFrontMatterInfo,
};

// ---- Loader + command execution ------------------------------------------

interface LoadedPlugin { instance: Plugin; style?: HTMLLinkElement }
const loaded = new Map<string, LoadedPlugin>();
let storeSubscribed = false;
const warnings = new Map<string, Set<string>>();

function compatibilityWarning(pluginId: string, message: string): void {
  const set = warnings.get(pluginId) ?? new Set<string>();
  set.add(message);
  warnings.set(pluginId, set);
  console.warn(`[plugin:${pluginId}] ${message}`);
}

declare global {
  // Called by the same-origin wrapper returned from /api/plugins/:id/module.js.
  // eslint-disable-next-line no-var
  var __webObsidianRequire: (pluginId: string, moduleName: string) => any;
}

globalThis.__webObsidianRequire = (pluginId: string, moduleName: string) => {
  if (moduleName === 'obsidian') return obsidianModule;
  throw new Error(`Plugin "${pluginId}" requires unsupported module "${moduleName}" (Node/Electron modules are unavailable on the web)`);
};

async function loadPlugin(id: string, manifest: any, bustCache = false): Promise<void> {
  if (loaded.has(id)) return;
  if (manifest.isDesktopOnly) {
    setPluginState({ id, name: manifest.name, status: 'incompatible', message: 'Desktop-only plugin (requires Node/Electron)' });
    return;
  }
  setPluginState({ id, name: manifest.name, status: 'loading' });
  let instance: Plugin | undefined;
  try {
    const query = new URLSearchParams({ v: String(manifest.version ?? '0'), ...(bustCache ? { reload: String(Date.now()) } : {}) });
    const module = await import(/* @vite-ignore */ `/api/plugins/${encodeURIComponent(id)}/module.js?${query}`);
    const PluginClass = module.default;
    if (typeof PluginClass !== 'function') throw new Error('main.js does not export a Plugin class');
    const pluginInstance = new PluginClass(sharedApp, { ...manifest, dir: manifest.dir ?? `.obsidian/plugins/${id}` }) as Plugin;
    instance = pluginInstance;
    await pluginInstance.loadAsync();
    let style: HTMLLinkElement | undefined;
    if (manifest.hasStyles) {
      style = document.createElement('link');
      style.rel = 'stylesheet';
      style.dataset.pluginId = id;
      style.href = `/api/plugins/${encodeURIComponent(id)}/styles.css?v=${encodeURIComponent(manifest.version ?? '')}`;
      document.head.appendChild(style);
    }
    loaded.set(id, { instance: pluginInstance, style });
    sharedApp.plugins.enabledPlugins.add(id);
    queueMicrotask(() => sharedApp.metadataCache.trigger('resolved'));
    setPluginState({ id, name: manifest.name, status: 'loaded', loadedAt: Date.now() });
    console.info(`[plugin] loaded ${id}`);
  } catch (error: any) {
    try { instance?.unload(); } catch { /* best effort */ }
    const message = error instanceof Error ? error.message : String(error);
    setPluginState({ id, name: manifest.name, status: 'failed', message });
    console.warn(`[plugin] failed to load ${id}:`, error);
    new Notice(`Plugin "${manifest.name}" failed: ${message}`, 7000);
  }
}

async function unloadPlugin(id: string): Promise<void> {
  const entry = loaded.get(id);
  if (!entry) return;
  try { entry.instance.unload(); } catch (error) { console.error(`[plugin] failed to unload ${id}`, error); }
  entry.style?.remove();
  loaded.delete(id);
  sharedApp.plugins.enabledPlugins.delete(id);
  warnings.delete(id);
}

function subscribeStoreEvents(): void {
  if (storeSubscribed) return;
  storeSubscribed = true;
  useStore.subscribe((state, previous) => {
    if (state.activePath !== previous.activePath) {
      sharedApp.workspace.trigger('active-leaf-change', sharedApp.workspace.activeLeaf);
      sharedApp.workspace.trigger('file-open', sharedApp.workspace.getActiveFile());
    }
    if (state.content !== previous.content && state.activePath === previous.activePath) {
      const file = sharedApp.workspace.getActiveFile();
      if (file) sharedApp.workspace.trigger('quick-preview', file, state.content);
    }
  });
}

/** Load all enabled plugins. Failed plugins remain visible with diagnostics. */
export async function loadPlugins(): Promise<void> {
  installDomHelpers();
  subscribeStoreEvents();
  const { plugins } = await api.listPlugins();
  const enabledIds = new Set(plugins.filter((plugin: any) => plugin.enabled).map((plugin: any) => plugin.id));
  for (const id of [...loaded.keys()]) if (!enabledIds.has(id)) await unloadPlugin(id);
  for (const plugin of plugins) {
    if (!plugin.enabled) {
      setPluginState({ id: plugin.id, name: plugin.name, status: 'disabled' });
      continue;
    }
    await loadPlugin(plugin.id, plugin);
  }
}

export async function enablePlugin(id: string): Promise<void> {
  await api.setPluginEnabled(id, true);
  const manifest = (await api.listPlugins()).plugins.find((plugin: any) => plugin.id === id);
  if (!manifest) throw new Error('Plugin is not installed');
  await loadPlugin(id, { ...manifest, enabled: true }, true);
}

export async function disablePlugin(id: string): Promise<void> {
  await api.setPluginEnabled(id, false);
  await unloadPlugin(id);
  const current = pluginStates.get(id);
  setPluginState({ id, name: current?.name ?? id, status: 'disabled' });
}

export async function reloadPlugin(id: string): Promise<void> {
  await unloadPlugin(id);
  const manifest = (await api.listPlugins()).plugins.find((plugin: any) => plugin.id === id);
  if (!manifest?.enabled) throw new Error('Plugin is disabled');
  await loadPlugin(id, manifest, true);
}

export function canRunPluginCommand(id: string): boolean {
  const entry = commands.get(id);
  if (!entry) return false;
  const command = entry.command;
  try {
    if (command.checkCallback) return command.checkCallback(true) !== false;
    if (command.editorCheckCallback) return command.editorCheckCallback(true, new Editor(), sharedApp.workspace.getActiveViewOfType(MarkdownView)) !== false;
    return true;
  } catch { return false; }
}

export function runPluginCommand(id: string): boolean {
  const entry = commands.get(id);
  if (!entry) return false;
  const command = entry.command;
  try {
    if (command.checkCallback) return command.checkCallback(false) !== false;
    const view = sharedApp.workspace.getActiveViewOfType(MarkdownView);
    if (command.editorCheckCallback) return command.editorCheckCallback(false, new Editor(), view) !== false;
    if (command.editorCallback) { command.editorCallback(new Editor(), view); return true; }
    command.callback?.();
    return true;
  } catch (error: any) {
    console.error(`[plugin:command:${id}]`, error);
    new Notice(`Command failed: ${error?.message ?? error}`);
    return false;
  }
}

export function handlePluginHotkey(event: KeyboardEvent): boolean {
  for (const entry of commands.values()) {
    const hotkeys = entry.command.hotkeys ?? entry.command.defaultHotkeys ?? [];
    for (const hotkey of hotkeys) {
      if (!hotkeyMatches(event, hotkey)) continue;
      if (!canRunPluginCommand(entry.id)) return false;
      event.preventDefault();
      event.stopPropagation();
      runPluginCommand(entry.id);
      return true;
    }
  }
  return false;
}

function hotkeyMatches(event: KeyboardEvent, hotkey: any): boolean {
  if (String(hotkey.key ?? '').toLowerCase() !== event.key.toLowerCase()) return false;
  const modifiers = new Set((hotkey.modifiers ?? []).map((value: string) => value.toLowerCase()));
  const mod = modifiers.has('mod');
  const expectCtrl = mod ? !Platform.isMacOS : modifiers.has('ctrl');
  const expectMeta = mod ? Platform.isMacOS : modifiers.has('meta');
  return event.shiftKey === modifiers.has('shift')
    && event.altKey === modifiers.has('alt')
    && event.ctrlKey === expectCtrl
    && event.metaKey === expectMeta;
}

export function handlePluginFilesystemEvent(event: string, path: string): void {
  if (!path) return;
  const file = abstractFile(path) ?? (/\.[^/]+$/.test(path) ? new TFile(path) : new TFolder(path));
  if (event === 'unlink' || event === 'unlinkDir') sharedApp.vault.trigger('delete', file);
  else if (event === 'add' || event === 'addDir') sharedApp.vault.trigger('create', file);
  else sharedApp.vault.trigger('modify', file);
  if (file instanceof TFile && /\.(md|markdown)$/i.test(file.path)) sharedApp.metadataCache.trigger('changed', file, '', null);
}
