/**
 * Browser-side Obsidian community-plugin compatibility runtime.
 *
 * Community plugins are trusted code, just as they are in desktop Obsidian.
 * They execute in the WebObsidian origin and can use the authenticated vault
 * API. Desktop-only plugins (Node/Electron) are rejected before execution.
 */
import moment from 'moment';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as CodeMirrorAutocomplete from '@codemirror/autocomplete';
import * as CodeMirrorCommands from '@codemirror/commands';
import * as CodeMirrorLanguage from '@codemirror/language';
import * as CodeMirrorState from '@codemirror/state';
import * as CodeMirrorView from '@codemirror/view';
import * as LezerLR from '@lezer/lr';
import * as ReactModule from 'react';
import * as AjvFormats from 'ajv-formats/dist/formats.js';
import AjvEqual from 'ajv/dist/runtime/equal.js';
import AjvUcs2Length from 'ajv/dist/runtime/ucs2length.js';
import AjvUri from 'ajv/dist/runtime/uri.js';
import AjvValidationError from 'ajv/dist/runtime/validation_error.js';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
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

/**
 * Obsidian still exposes a small CodeMirror 5 compatibility global. Templater
 * registers its bundled legacy modes at module-evaluation time even when its
 * CM6 syntax highlighter is disabled, so the registration surface must exist
 * before community plugin code runs.
 */
function installLegacyCodeMirrorShim(): void {
  const activeWindow = window as any;
  if (activeWindow.CodeMirror) return;
  const modes = new Map<string, AnyFn>();
  const mimes = new Map<string, any>();
  const helpers = new Map<string, Map<string, any>>();
  const nullMode = {
    name: 'null',
    startState: () => ({}),
    token(stream: any) { stream?.skipToEnd?.(); return null; },
  };

  activeWindow.CodeMirror = {
    Pass: Symbol('CodeMirror.Pass'),
    defineMode(name: string, factory: AnyFn) { modes.set(name, factory); },
    defineMIME(mime: string, spec: any) { mimes.set(mime, spec); },
    registerHelper(type: string, name: string, value: any) {
      const group = helpers.get(type) ?? new Map<string, any>();
      group.set(name, value);
      helpers.set(type, group);
    },
    getMode(config: any, requested: any) {
      let spec = typeof requested === 'string' ? (mimes.get(requested) ?? requested) : requested;
      const name = typeof spec === 'string' ? spec : spec?.name;
      const factory = modes.get(name);
      if (!factory) return nullMode;
      const mode = factory(config ?? {}, spec ?? {});
      if (mode && !mode.name) mode.name = name;
      return mode;
    },
    startState(mode: any, ...args: any[]) { return mode?.startState ? mode.startState(...args) : {}; },
    copyState(mode: any, state: any) {
      if (mode?.copyState) return mode.copyState(state);
      if (state && typeof state === 'object') return Array.isArray(state) ? [...state] : { ...state };
      return state;
    },
  };
}

function installDomHelpers(): void {
  if (domHelpersInstalled) return;
  domHelpersInstalled = true;
  installLegacyCodeMirrorShim();
  const nodeProto = Node.prototype as any;
  const elementProto = Element.prototype as any;
  const htmlProto = HTMLElement.prototype as any;
  const fragmentProto = DocumentFragment.prototype as any;
  const eventProto = Event.prototype as any;
  const define = (target: object, name: string, value: AnyFn | PropertyDescriptor) => {
    if (name in target) return;
    Object.defineProperty(
      target,
      name,
      typeof value === 'function' ? { value, configurable: true } : { ...value, configurable: true },
    );
  };

  const activeWindow = window as any;
  activeWindow.activeWindow = window;
  activeWindow.activeDocument = document;
  activeWindow.moment = moment;
  activeWindow.sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  activeWindow.nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  activeWindow.createEl = createEl;
  activeWindow.createDiv = createDiv;
  activeWindow.createSpan = createSpan;
  activeWindow.createFragment = createFragment;
  (globalThis as any).activeWindow = window;
  (globalThis as any).activeDocument = document;
  (globalThis as any).moment = moment;
  (globalThis as any).sleep = activeWindow.sleep;
  (globalThis as any).nextFrame = activeWindow.nextFrame;
  (globalThis as any).createEl = createEl;
  (globalThis as any).createDiv = createDiv;
  (globalThis as any).createSpan = createSpan;
  (globalThis as any).createFragment = createFragment;
  (globalThis as any).app = sharedApp;

  define(Object, 'isEmpty', (value: Record<string, unknown>) => !value || Object.keys(value).length === 0);
  define(Object, 'each', (value: Record<string, unknown>, callback: AnyFn, context?: unknown) => {
    for (const [key, item] of Object.entries(value ?? {})) if (callback.call(context, item, key) === false) return false;
    return true;
  });
  define(Array, 'combine', (arrays: unknown[][]) => arrays.flat());
  define(Array.prototype, 'first', function (this: unknown[]) { return this[0]; });
  define(Array.prototype, 'last', function (this: unknown[]) { return this[this.length - 1]; });
  define(Array.prototype, 'contains', function (this: unknown[], value: unknown) { return this.includes(value); });
  define(Array.prototype, 'remove', function (this: unknown[], value: unknown) {
    const index = this.indexOf(value);
    if (index >= 0) this.splice(index, 1);
  });
  define(Array.prototype, 'shuffle', function (this: unknown[]) {
    for (let index = this.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [this[index], this[swap]] = [this[swap], this[index]];
    }
    return this;
  });
  define(Array.prototype, 'unique', function (this: unknown[]) { return [...new Set(this)]; });
  define(Math, 'clamp', (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)));
  define(Math, 'square', (value: number) => value * value);
  define(String, 'isString', (value: unknown) => typeof value === 'string');
  define(String.prototype, 'contains', function (this: string, value: string) { return this.includes(value); });
  define(String.prototype, 'format', function (this: string, ...args: string[]) {
    return this.replace(/\{(\d+)\}/g, (match, index) => args[Number(index)] ?? match);
  });
  define(Number, 'isNumber', (value: unknown) => typeof value === 'number');

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

  define(nodeProto, 'detach', function (this: Node) { this.parentNode?.removeChild(this); });
  define(nodeProto, 'empty', function (this: Node) { while (this.firstChild) this.removeChild(this.firstChild); });
  define(nodeProto, 'insertAfter', function <T extends Node>(this: Node, node: T, child: Node | null) {
    return this.insertBefore(node, child?.nextSibling ?? this.firstChild);
  });
  define(nodeProto, 'indexOf', function (this: Node, other: Node) { return [...this.childNodes].indexOf(other as ChildNode); });
  define(nodeProto, 'setChildrenInPlace', function (this: Node, children: Node[]) {
    while (this.firstChild) this.removeChild(this.firstChild);
    children.forEach((child) => this.appendChild(child));
  });
  define(nodeProto, 'appendText', function (this: Node, value: string) { this.appendChild(document.createTextNode(value)); });
  define(nodeProto, 'instanceOf', function (this: Node, type: AnyFn) {
    const targetWindow = (this.ownerDocument?.defaultView ?? window) as any;
    return this instanceof type || Boolean(targetWindow?.[type?.name] && this instanceof targetWindow[type.name]);
  });
  define(nodeProto, 'doc', { get(this: Node) { return this.ownerDocument ?? document; } });
  define(nodeProto, 'win', { get(this: Node) { return this.ownerDocument?.defaultView ?? window; } });
  define(nodeProto, 'constructorWin', { get(this: Node) { return this.ownerDocument?.defaultView ?? window; } });

  define(elementProto, 'getText', function (this: Element) { return this.textContent ?? ''; });
  define(elementProto, 'setText', function (this: Element, text: unknown) {
    if (text instanceof DocumentFragment) this.replaceChildren(text);
    else this.textContent = String(text ?? '');
    return this;
  });
  define(elementProto, 'addClass', function (this: Element, ...classes: string[]) { this.classList.add(...classes.flatMap(splitClasses)); return this; });
  define(elementProto, 'addClasses', function (this: Element, classes: string[]) { this.classList.add(...classes.flatMap(splitClasses)); return this; });
  define(elementProto, 'removeClass', function (this: Element, ...classes: string[]) { this.classList.remove(...classes.flatMap(splitClasses)); return this; });
  define(elementProto, 'removeClasses', function (this: Element, classes: string[]) { this.classList.remove(...classes.flatMap(splitClasses)); return this; });
  define(elementProto, 'toggleClass', function (this: Element, classes: string | string[], value?: boolean) {
    const names = Array.isArray(classes) ? classes : splitClasses(classes);
    names.forEach((name) => this.classList.toggle(name, value));
    return this;
  });
  define(elementProto, 'hasClass', function (this: Element, cls: string) { return this.classList.contains(cls); });
  define(elementProto, 'setAttr', function (this: Element, name: string, value: unknown) {
    if (value === null) this.removeAttribute(name); else this.setAttribute(name, String(value));
    return this;
  });
  define(elementProto, 'setAttrs', function (this: Element, attrs: Record<string, unknown>) {
    Object.entries(attrs).forEach(([name, value]) => {
      if (value === null) this.removeAttribute(name); else this.setAttribute(name, String(value));
    });
    return this;
  });
  define(elementProto, 'getAttr', function (this: Element, name: string) { return this.getAttribute(name); });
  define(elementProto, 'matchParent', function (this: Element, selector: string, lastParent?: Element) {
    let current: Element | null = this;
    while (current && current !== lastParent) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  });
  define(elementProto, 'getCssPropertyValue', function (this: Element, property: string, pseudo?: string) {
    return getComputedStyle(this, pseudo || null).getPropertyValue(property);
  });
  define(elementProto, 'isActiveElement', function (this: Element) { return this.ownerDocument.activeElement === this; });

  define(htmlProto, 'createEl', create);
  define(htmlProto, 'createDiv', function (this: HTMLElement, options?: any) { return create.call(this, 'div', options); });
  define(htmlProto, 'createSpan', function (this: HTMLElement, options?: any) { return create.call(this, 'span', options); });
  define(htmlProto, 'createSvg', createSvg);
  define(fragmentProto, 'createEl', create);
  define(fragmentProto, 'createDiv', function (this: DocumentFragment, options?: any) { return create.call(this as any, 'div', options); });
  define(fragmentProto, 'createSpan', function (this: DocumentFragment, options?: any) { return create.call(this as any, 'span', options); });
  define(htmlProto, 'show', function (this: HTMLElement) { this.style.display = ''; return this; });
  define(htmlProto, 'hide', function (this: HTMLElement) { this.style.display = 'none'; return this; });
  define(htmlProto, 'toggle', function (this: HTMLElement, show: boolean) { this.style.display = show ? '' : 'none'; return this; });
  define(htmlProto, 'toggleVisibility', function (this: HTMLElement, visible: boolean) { this.style.visibility = visible ? '' : 'hidden'; return this; });
  define(htmlProto, 'isShown', function (this: HTMLElement) { return this.isConnected && getComputedStyle(this).display !== 'none'; });
  define(htmlProto, 'setCssStyles', function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); return this; });
  define(htmlProto, 'setCssProps', function (this: HTMLElement, props: Record<string, string>) { Object.entries(props).forEach(([name, value]) => this.style.setProperty(name, value)); return this; });
  define(htmlProto, 'innerWidth', { get(this: HTMLElement) { const style = getComputedStyle(this); return this.clientWidth - Number.parseFloat(style.paddingLeft || '0') - Number.parseFloat(style.paddingRight || '0'); } });
  define(htmlProto, 'onWindowMigrated', function () { return () => {}; });
  define(htmlProto, 'trigger', function (this: HTMLElement, type: string) { this.dispatchEvent(new Event(type, { bubbles: true })); });

  define(eventProto, 'targetNode', { get(this: Event) { return this.target instanceof Node ? this.target : null; } });
  define(eventProto, 'doc', { get(this: Event) { return (this.target as Node | null)?.ownerDocument ?? document; } });
  define(eventProto, 'win', { get(this: Event) { return (this.target as Node | null)?.ownerDocument?.defaultView ?? window; } });
  define(eventProto, 'instanceOf', function (this: Event, type: AnyFn) {
    const targetWindow = ((this.target as Node | null)?.ownerDocument?.defaultView ?? window) as any;
    return this instanceof type || Boolean(targetWindow?.[type?.name] && this instanceof targetWindow[type.name]);
  });
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

export class BaseComponent {
  disabled = false;
  then(callback: (component: this) => any): this { callback(this); return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
}

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
  static recurseChildren(root: TAbstractFile, callback: (file: TAbstractFile) => void): void {
    if (!(root instanceof TFolder)) return;
    for (const child of root.children) {
      callback(child);
      Vault.recurseChildren(child, callback);
    }
  }
  getName(): string { return useStore.getState().tree?.name ?? 'WebObsidian'; }
  getConfig(_key: string): unknown { return undefined; }
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

/**
 * Type marker used by plugins before calling desktop-only filesystem helpers.
 * WebObsidian's vault adapter deliberately does not extend this class, so a
 * well-behaved plugin will keep "reveal in explorer" actions disabled.
 */
export class FileSystemAdapter {
  getName(): string { return 'WebObsidian'; }
  getBasePath(): string { throw new Error('Local filesystem paths are unavailable in WebObsidian'); }
  getFullPath(_path: string): string { throw new Error('Local filesystem paths are unavailable in WebObsidian'); }
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

export const editorLivePreviewField = CodeMirrorState.StateField.define<boolean>({
  create: () => true,
  update: (value) => value,
});
export const editorInfoField = CodeMirrorState.StateField.define<any>({
  create: () => ({ app: sharedApp, editor: new Editor(), file: sharedApp.workspace.getActiveFile() }),
  update: (value) => value,
});
export const editorEditorField = CodeMirrorState.StateField.define<any>({
  create: () => getActiveEditor(),
  update: (value) => value,
});

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

export class WorkspaceItem extends Events {
  parent: WorkspaceParent | null = null;
  getRoot(): WorkspaceItem {
    let item: WorkspaceItem = this;
    while (item.parent) item = item.parent;
    return item;
  }
}
export class WorkspaceParent extends WorkspaceItem {}
export class WorkspaceSplit extends WorkspaceParent {
  constructor(public region: 'main' | 'left' | 'right' = 'main') { super(); }
  get collapsed(): boolean {
    const state = useStore.getState();
    return this.region === 'left' ? !state.leftOpen : this.region === 'right' ? !state.rightOpen : false;
  }
  collapse(): void {
    if (this.region === 'left') useStore.setState({ leftOpen: false });
    if (this.region === 'right') useStore.setState({ rightOpen: false });
  }
  expand(): void {
    if (this.region === 'left') useStore.setState({ leftOpen: true });
    if (this.region === 'right') useStore.setState({ rightOpen: true });
  }
  toggle(): void { this.collapsed ? this.expand() : this.collapse(); }
}

export class WorkspaceLeaf extends WorkspaceItem {
  readonly id = contributionId('workspace', 'leaf');
  get app(): App { return sharedApp; }
  view: View;
  private state: any = { type: 'empty', state: {} };
  constructor(public region: 'main' | 'left' | 'right' = 'main') { super(); this.view = new EmptyView(this); }
  async openFile(file: TFile): Promise<void> { await useStore.getState().openFile(file.path); }
  async open(view: View): Promise<View> { await this.view.onClose(); this.view = view; await view.onOpen(); return view; }
  getViewState(): any { return this.state; }
  async setViewState(state: any): Promise<void> {
    const registered = viewCreators.get(state.type);
    if (!registered) throw new Error(`No view registered for type: ${state.type}`);
    const previousEntry = [...activeViews].find(([, leaf]) => leaf === this);
    if (previousEntry) activeViews.delete(previousEntry[0]);
    this.state = state;
    await this.view.onClose();
    this.view = registered.creator(this);
    await this.view.setState(state.state ?? {}, {});
    await this.view.onOpen();
    const path = `${PLUGIN_VIEW_PREFIX}${encodeURIComponent(state.type)}/${this.id}`;
    activeViews.set(path, this);
    const title = this.view.getDisplayText();
    if (this.region === 'main') {
      await useStore.getState().openFile(path);
      useStore.setState((current) => ({ tabs: current.tabs.map((tab) => tab.path === path ? { ...tab, title } : tab) }));
    } else {
      useStore.getState().showPluginSidebar(this.region, path);
    }
    changed();
  }
  async loadIfDeferred(): Promise<void> {}
  get isDeferred(): boolean { return false; }
  getEphemeralState(): any { return {}; }
  setEphemeralState(_state: any): void {}
  togglePinned(): void {}
  setPinned(_pinned: boolean): void {}
  setGroupMember(_other: WorkspaceLeaf): void {}
  setGroup(_group: string): void {}
  detach(): void {
    const entry = [...activeViews].find(([, leaf]) => leaf === this);
    if (!entry) return;
    void this.view.onClose();
    activeViews.delete(entry[0]);
    if (this.region === 'main') useStore.getState().closeTab(entry[0]);
    else {
      const state = useStore.getState();
      const activePath = this.region === 'left' ? state.pluginLeftPath : state.pluginRightPath;
      if (activePath === entry[0]) state.showPluginSidebar(this.region, null);
    }
    changed();
  }
  getIcon(): string { return this.view.getIcon(); }
  getDisplayText(): string { return this.view.getDisplayText(); }
  onResize(): void { this.view.onResize(); }
}

export class View extends Component {
  app: App;
  containerEl: HTMLElement;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
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
  headerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'view-header plugin-view-header';
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'view-content';
    // Obsidian ItemView exposes the header as child 0 and content as child 1.
    // Several community plugins intentionally use this stable DOM contract.
    this.containerEl.append(this.headerEl, this.contentEl);
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
  rootSplit = new WorkspaceSplit('main');
  leftSplit = new WorkspaceSplit('left');
  rightSplit = new WorkspaceSplit('right');
  private createLeaf(region: 'main' | 'left' | 'right'): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(region);
    leaf.parent = region === 'left' ? this.leftSplit : region === 'right' ? this.rightSplit : this.rootSplit;
    return leaf;
  }
  onLayoutReady(callback: () => any): void { queueMicrotask(callback); }
  getActiveFile(): TFile | null { const path = useStore.getState().activePath; const file = path ? abstractFile(path) : null; return file instanceof TFile ? file : null; }
  get activeLeaf(): WorkspaceLeaf | null {
    const path = useStore.getState().activePath;
    if (path && activeViews.has(path)) return activeViews.get(path)!;
    const leaf = this.createLeaf('main');
    if (path && /\.(md|markdown)$/i.test(path)) { const view = new MarkdownView(leaf); view.file = this.getActiveFile(); leaf.view = view; }
    return leaf;
  }
  getLeaf(newLeaf?: any): WorkspaceLeaf { return newLeaf ? this.createLeaf('main') : this.activeLeaf ?? this.createLeaf('main'); }
  getLeftLeaf(_split: boolean): WorkspaceLeaf { return this.createLeaf('left'); }
  getRightLeaf(_split: boolean): WorkspaceLeaf { return this.createLeaf('right'); }
  async openLinkText(linktext: string, _sourcePath: string, _newLeaf?: any): Promise<void> { await useStore.getState().openWikilink(linktext); }
  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null { const view = this.activeLeaf?.view; return view instanceof type ? view : null; }
  getLeavesOfType(type: string): WorkspaceLeaf[] { return [...activeViews.values()].filter((leaf) => leaf.view.getViewType() === type); }
  detachLeavesOfType(type: string): void { this.getLeavesOfType(type).forEach((leaf) => leaf.detach()); }
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    const seen = new Set<WorkspaceLeaf>();
    for (const leaf of activeViews.values()) {
      if (leaf.region === 'main' && !seen.has(leaf)) { seen.add(leaf); callback(leaf); }
    }
    const active = this.activeLeaf;
    if (active && !seen.has(active)) callback(active);
  }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    const seen = new Set<WorkspaceLeaf>();
    for (const leaf of activeViews.values()) if (!seen.has(leaf)) { seen.add(leaf); callback(leaf); }
    const active = this.activeLeaf;
    if (active && !seen.has(active)) callback(active);
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const entry = [...activeViews].find(([, item]) => item === leaf);
    if (!entry) return;
    if (leaf.region === 'main') await useStore.getState().openFile(entry[0]);
    else useStore.getState().showPluginSidebar(leaf.region, entry[0]);
  }
  setActiveLeaf(leaf: WorkspaceLeaf): void { void this.revealLeaf(leaf); }
  getLeafById(id: string): WorkspaceLeaf | null { return [...activeViews.values()].find((leaf) => leaf.id === id) ?? null; }
  getMostRecentLeaf(root?: WorkspaceItem): WorkspaceLeaf | null {
    const region = root instanceof WorkspaceSplit ? root.region : 'main';
    const leaves = [...activeViews.values()].filter((leaf) => leaf.region === region);
    return leaves.at(-1) ?? (region === 'main' ? this.activeLeaf : null);
  }
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

function getPluginUiHost(): HTMLElement {
  return (document.querySelector('.theme-dark, .theme-light') as HTMLElement | null) ?? document.body;
}

export class Notice {
  noticeEl: HTMLElement;
  constructor(message: string | DocumentFragment, timeout = 4000) {
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'toast plugin-notice';
    if (typeof message === 'string') this.noticeEl.textContent = message;
    else this.noticeEl.appendChild(message);
    getPluginUiHost().appendChild(this.noticeEl);
    if (timeout > 0) window.setTimeout(() => this.hide(), timeout);
  }
  setMessage(message: string | DocumentFragment): this { setNodeContent(this.noticeEl, message); return this; }
  hide(): void { this.noticeEl.remove(); }
}

export class Modal {
  containerEl = document.createElement('div');
  modalEl = document.createElement('div');
  closeButtonEl = document.createElement('button');
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  scope = new Scope();
  constructor(public app: App) {
    this.containerEl.className = 'modal-bg plugin-modal-bg';
    this.modalEl.className = 'modal plugin-modal';
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.closeButtonEl.className = 'modal-close-button';
    this.closeButtonEl.type = 'button';
    this.closeButtonEl.setAttribute('aria-label', 'Close');
    this.closeButtonEl.textContent = '×';
    this.titleEl.className = 'modal-title';
    this.contentEl.className = 'modal-content';
    this.modalEl.append(this.closeButtonEl, this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.closeButtonEl.addEventListener('click', () => this.close());
    this.containerEl.addEventListener('mousedown', (event) => { if (event.target === this.containerEl) this.close(); });
    this.scope.register([], 'Escape', () => this.close());
  }
  setTitle(title: string): this { this.titleEl.textContent = title; return this; }
  setContent(content: string | DocumentFragment): this { setNodeContent(this.contentEl, content); return this; }
  open(): void { getPluginUiHost().appendChild(this.containerEl); this.scope.activate(); this.onOpen(); }
  close(): void { this.onClose(); this.scope.deactivate(); this.containerEl.remove(); }
  onOpen(): void {}
  onClose(): void {}
}

export abstract class PopoverSuggest<T> {
  scope = new Scope();
  suggestEl = document.createElement('div');
  protected values: T[] = [];
  protected selectedIndex = 0;
  constructor(public app: App) {
    this.suggestEl.className = 'suggestion-container plugin-suggestion-container';
  }
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  open(): void {
    if (!this.suggestEl.isConnected) getPluginUiHost().appendChild(this.suggestEl);
    this.scope.activate();
  }
  close(): void {
    this.scope.deactivate();
    this.suggestEl.remove();
  }
  protected renderValues(): void {
    this.suggestEl.replaceChildren();
    this.values.forEach((value, index) => {
      const row = document.createElement('div');
      row.className = 'suggestion-item';
      row.classList.toggle('is-selected', index === this.selectedIndex);
      this.renderSuggestion(value, row);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.selectedIndex = index;
        this.selectSuggestion(value, event);
        this.close();
      });
      this.suggestEl.appendChild(row);
    });
  }
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  private selectCallback?: (value: T, evt: MouseEvent | KeyboardEvent) => any;
  private inputListener = () => void this.refresh();
  private focusListener = () => void this.refresh();
  private outsideListener = (event: MouseEvent) => {
    if (event.target !== this.textInputEl && !this.suggestEl.contains(event.target as Node)) this.close();
  };
  private keyListener = (event: KeyboardEvent) => {
    if (!this.values.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + delta + this.values.length) % this.values.length;
      this.renderValues();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const value = this.values[this.selectedIndex];
      if (value !== undefined) this.selectSuggestion(value, event);
      this.close();
    } else if (event.key === 'Escape') {
      this.close();
    }
  };

  constructor(app: App, public textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    textInputEl.addEventListener('input', this.inputListener);
    textInputEl.addEventListener('focus', this.focusListener);
    textInputEl.addEventListener('keydown', this.keyListener as EventListener);
    document.addEventListener('mousedown', this.outsideListener, true);
  }
  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }
  getValue(): string { return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : this.textInputEl.textContent ?? ''; }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  renderSuggestion(value: T, el: HTMLElement): void { el.textContent = String(value); }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.setValue(String(value));
    this.selectCallback?.(value, evt);
  }
  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => any): this { this.selectCallback = callback; return this; }
  override open(): void { super.open(); this.position(); }
  override close(): void { super.close(); }
  private position(): void {
    const rect = this.textInputEl.getBoundingClientRect();
    this.suggestEl.style.position = 'fixed';
    this.suggestEl.style.left = `${rect.left}px`;
    this.suggestEl.style.top = `${rect.bottom + 4}px`;
    this.suggestEl.style.minWidth = `${Math.max(rect.width, 180)}px`;
    this.suggestEl.style.zIndex = '10000';
  }
  private async refresh(): Promise<void> {
    const values = await this.getSuggestions(this.getValue());
    this.values = values.slice(0, this.limit || values.length);
    this.selectedIndex = 0;
    if (!this.values.length) { this.close(); return; }
    this.open();
    this.renderValues();
  }
}

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: any = null;
  limit = 100;
  constructor(app: App) { super(app); }
  setInstructions(_instructions: any[]): void {}
  abstract onTrigger(cursor: any, editor: Editor, file: TFile | null): any;
  abstract getSuggestions(context: any): T[] | Promise<T[]>;
}

export class SuggestModal<T> extends Modal {
  inputEl = document.createElement('input');
  inputContainerEl = document.createElement('div');
  resultContainerEl = document.createElement('div');
  emptyStateText = 'No matches found';
  limit = 100;
  private suggestions: T[] = [];
  private selectedIndex = 0;
  private refreshId = 0;
  constructor(app: App) {
    super(app);
    this.containerEl.classList.add('plugin-suggest-modal-bg');
    this.modalEl.classList.add('mod-search', 'plugin-suggest-modal');
    this.contentEl.classList.add('plugin-suggest-modal-content');
    this.inputContainerEl.className = 'prompt-input-container plugin-suggest-input-container';
    this.inputEl.className = 'prompt-input plugin-suggest-input';
    this.inputEl.type = 'text';
    this.inputEl.autocomplete = 'off';
    this.inputEl.spellcheck = false;
    this.resultContainerEl.className = 'suggestion-container mod-search-suggestion plugin-suggest-results';
    this.inputContainerEl.appendChild(this.inputEl);
    this.contentEl.append(this.inputContainerEl, this.resultContainerEl);
    this.inputEl.addEventListener('input', () => void this.refresh());
    this.inputEl.addEventListener('keydown', (event) => this.onKeyDown(event));
  }
  setPlaceholder(value: string): void { this.inputEl.placeholder = value; }
  setInstructions(_instructions: any[]): void {}
  getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
  renderSuggestion(value: T, el: HTMLElement): void { el.textContent = this.getItemText(value); }
  getItemText(value: T): string { return String(value); }
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void { this.onChooseSuggestion(value, evt); }
  override open(): void { super.open(); void this.refresh(); this.inputEl.focus(); }
  private onKeyDown(event: KeyboardEvent): void {
    if (!this.suggestions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + direction + this.suggestions.length) % this.suggestions.length;
      this.updateSelectedRow(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.choose(this.suggestions[this.selectedIndex], event);
    }
  }
  private choose(value: T | undefined, event: MouseEvent | KeyboardEvent): void {
    if (value === undefined) return;
    this.selectSuggestion(value, event);
    this.close();
  }
  private updateSelectedRow(scrollIntoView = false): void {
    const rows = [...this.resultContainerEl.querySelectorAll<HTMLElement>('.suggestion-item')];
    rows.forEach((row, index) => row.classList.toggle('is-selected', index === this.selectedIndex));
    if (scrollIntoView) rows[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }
  private async refresh(): Promise<void> {
    const refreshId = ++this.refreshId;
    const values = (await this.getSuggestions(this.inputEl.value)).slice(0, this.limit);
    if (refreshId !== this.refreshId) return;
    this.suggestions = values;
    this.selectedIndex = 0;
    this.resultContainerEl.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('div');
      empty.className = 'suggestion-empty';
      empty.textContent = this.emptyStateText;
      this.resultContainerEl.appendChild(empty);
      return;
    }
    values.forEach((value, index) => {
      const row = document.createElement('div');
      row.className = 'suggestion-item';
      row.classList.toggle('is-selected', index === this.selectedIndex);
      this.renderSuggestion(value, row);
      row.addEventListener('mouseenter', () => { this.selectedIndex = index; this.updateSelectedRow(); });
      row.addEventListener('click', (event) => this.choose(value, event));
      this.resultContainerEl.appendChild(row);
    });
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

abstract class ValueComponent<T> extends BaseComponent {
  constructor(public containerEl: HTMLElement) { super(); }
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
  addOption(value: string, display: string): this {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = display;
    this.selectEl.appendChild(option);
    return this;
  }
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
export class ExtraButtonComponent extends ButtonComponent {
  extraSettingsEl = this.buttonEl;
}

/**
 * Button hosted by Obsidian's confirmation modal. Unlike a regular
 * ButtonComponent it closes the owning modal after its handler resolves. A
 * truthy handler result keeps the modal open so plugins can surface validation
 * errors without rebuilding the dialog.
 */
export class ConfirmationButton extends ButtonComponent {
  constructor(containerEl: HTMLElement, private owner: ConfirmationModal) { super(containerEl); }

  override onClick(handler: (event: MouseEvent) => unknown | Promise<unknown>): this {
    this.buttonEl.addEventListener('click', async (event) => {
      const keepOpen = await handler(event);
      if (!keepOpen) this.owner.close();
    });
    return this;
  }

  setInitialFocus(): this { this.owner.setInitialFocusButton(this); return this; }
  setSecondary(): this { this.buttonEl.classList.add('mod-secondary'); return this; }
  setCancel(): this { this.buttonEl.classList.add('mod-cancel'); return this; }
}

/** Public Obsidian 1.13 confirmation-dialog surface used by Templater 2.24+. */
export class ConfirmationModal extends Modal {
  buttonContainerEl = document.createElement('div');
  private initialFocusButton: ConfirmationButton | null = null;

  constructor(app: App) {
    super(app);
    this.buttonContainerEl.className = 'modal-button-container';
    this.modalEl.appendChild(this.buttonContainerEl);
  }

  addClass(cls: string): this { this.modalEl.classList.add(...splitClasses(cls)); return this; }

  addCheckbox(label: string, callback: (value: boolean) => any | Promise<any>): this {
    const wrapper = document.createElement('label');
    wrapper.className = 'confirmation-modal-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = label;
    checkbox.addEventListener('change', () => void callback(checkbox.checked));
    wrapper.append(checkbox, text);
    this.buttonContainerEl.appendChild(wrapper);
    return this;
  }

  addButton(callback: (button: ConfirmationButton) => any): this {
    callback(new ConfirmationButton(this.buttonContainerEl, this));
    return this;
  }

  addCancelButton(text = 'Cancel'): this {
    return this.addButton((button) => button.setButtonText(text).setCancel().onClick(() => false));
  }

  setInitialFocusButton(button: ConfirmationButton): void { this.initialFocusButton = button; }

  override open(): void {
    super.open();
    queueMicrotask(() => this.initialFocusButton?.buttonEl.focus());
  }
}

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
  setVisibility(visible: boolean): this { this.settingEl.hidden = !visible; return this; }
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

export class SettingGroup {
  listEl = document.createElement('div');
  constructor(public containerEl: HTMLElement) {
    this.listEl.className = 'setting-group-list';
    containerEl.appendChild(this.listEl);
  }
  setHeading(text: string | DocumentFragment): this {
    const heading = document.createElement('div');
    heading.className = 'setting-item setting-item-heading';
    setNodeContent(heading, text);
    this.containerEl.insertBefore(heading, this.listEl);
    return this;
  }
  addClass(...classes: string[]): this { this.containerEl.classList.add(...classes.flatMap(splitClasses)); return this; }
  addSetting(callback: (setting: Setting) => void): this { callback(new Setting(this.listEl)); return this; }
  addSearch(callback: (component: SearchComponent) => any): this { callback(new SearchComponent(this.listEl)); return this; }
  addExtraButton(callback: (component: ExtraButtonComponent) => any): this { callback(new ExtraButtonComponent(this.listEl)); return this; }
}

export abstract class SettingPage {
  rootEl = document.createElement('div');
  titlebarEl = document.createElement('div');
  containerEl = document.createElement('div');
  title = '';
  constructor() {
    this.rootEl.className = 'setting-page';
    this.titlebarEl.className = 'setting-page-titlebar';
    this.containerEl.className = 'setting-page-content';
    this.rootEl.append(this.titlebarEl, this.containerEl);
  }
  abstract display(): void;
  hide(): void { this.containerEl.replaceChildren(); }
}

export class PluginSettingTab {
  id: string;
  name: string;
  containerEl = document.createElement('div');
  icon = 'settings';
  private activePage: SettingPage | null = null;
  constructor(public app: App, public plugin: Plugin) { this.id = plugin.manifest.id; this.name = plugin.manifest.name; this.containerEl.className = 'plugin-setting-tab'; }
  getSettingDefinitions(): any[] { return []; }
  getControlValue(key: string): unknown { return (this.plugin as any).settings?.[key]; }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const instance = this.plugin as any;
    if (!instance.settings) instance.settings = {};
    instance.settings[key] = value;
    await instance.saveSettings?.();
  }
  display(): void {
    this.activePage?.hide();
    this.activePage = null;
    this.containerEl.replaceChildren();
    this.renderDefinitions(this.getSettingDefinitions(), this.containerEl);
  }
  hide(): void { this.activePage?.hide(); this.activePage = null; }
  private renderDefinitions(definitions: any[], container: HTMLElement): void {
    for (const definition of definitions ?? []) {
      if (definition?.type === 'group' || definition?.type === 'list') {
        const groupEl = document.createElement('div');
        groupEl.className = 'setting-definition-group';
        container.appendChild(groupEl);
        const group = new SettingGroup(groupEl);
        if (definition.heading) group.setHeading(definition.heading);
        this.renderDefinitions(definition.items ?? [], group.listEl);
        continue;
      }
      if (definition?.type === 'page' && typeof definition.page === 'function') {
        new Setting(container)
          .setName(definition.name ?? definition.title ?? 'Settings')
          .setDesc(definition.desc ?? '')
          .addButton((button) => button.setButtonText('Open').onClick(() => this.openPage(definition.page())));
        continue;
      }
      if (definition?.name || definition?.desc) new Setting(container).setName(definition.name ?? '').setDesc(definition.desc ?? '');
    }
  }
  private openPage(page: SettingPage): void {
    this.activePage?.hide();
    this.activePage = page;
    this.containerEl.replaceChildren();
    const back = document.createElement('button');
    back.className = 'btn secondary setting-page-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => this.display());
    page.titlebarEl.replaceChildren(back, document.createTextNode(page.title));
    this.containerEl.appendChild(page.rootEl);
    page.display();
  }
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
    el.type = 'button';
    el.title = title;
    el.setAttribute('aria-label', title);
    setIcon(el, icon);
    const onClick = (event: MouseEvent) => {
      try {
        Promise.resolve(callback(event)).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[plugin:${this.manifest.id}] Ribbon action failed`, error);
          new Notice(`${title}: ${message}`, 7000);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[plugin:${this.manifest.id}] Ribbon action failed`, error);
        new Notice(`${title}: ${message}`, 7000);
      }
    };
    el.addEventListener('click', onClick);
    this.register(() => el.removeEventListener('click', onClick));
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
  registerBasesView(viewId: string, registration: any): boolean {
    if (!viewId || typeof registration?.factory !== 'function') return false;
    if (basesViewRegistrations[viewId]) throw new Error(`Bases view already exists: ${viewId}`);
    basesViewRegistrations[viewId] = registration;
    this.register(() => {
      if (basesViewRegistrations[viewId] === registration) delete basesViewRegistrations[viewId];
    });
    compatibilityWarning(this.manifest.id, 'Bases view registered; .base query/render hosting remains partial');
    return true;
  }
  registerEditorExtension(_extension: unknown): void { compatibilityWarning(this.manifest.id, 'CodeMirror editor extensions are not yet mounted'); }
  registerEditorSuggest(_suggest: unknown): void { compatibilityWarning(this.manifest.id, 'EditorSuggest is not yet mounted'); }
  registerCliHandler(_command: string, _description: string, _flags: unknown, _handler: AnyFn): void {
    compatibilityWarning(this.manifest.id, 'CLI handlers are unavailable in the web application');
  }
  registerHoverLinkSource(_id: string, _info: unknown): void {}
  registerObsidianProtocolHandler(_action: string, _handler: AnyFn): void {}
  async loadData(): Promise<any> { return (await api.getPluginData(this.manifest.id)).data; }
  async saveData(data: unknown): Promise<void> { await api.putPluginData(this.manifest.id, data); }
  onUserEnable(): void {}
}

const pluginInstances: Record<string, Plugin> = {};
const pluginManifests: Record<string, any> = {};
const basesViewRegistrations: Record<string, any> = {};

export class App {
  vault = new Vault();
  workspace = new Workspace();
  metadataCache = new MetadataCache();
  metadataTypeManager = {
    getAllProperties: () => ({} as Record<string, { type?: string }>),
    setType: (_property: string, _type: string) => {},
  };
  fileManager = new FileManager(this);
  keymap = {};
  scope: Scope;
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
    plugins: pluginInstances,
    manifests: pluginManifests,
    getPlugin: (id: string) => pluginInstances[id],
  };
  internalPlugins = {
    plugins: {
      'daily-notes': { enabled: false, instance: { options: {} } },
    } as Record<string, any>,
    getPluginById: (id: string) => this.internalPlugins.plugins[id] ?? null,
    getEnabledPluginById: (id: string) => id === 'bases'
      ? { registrations: basesViewRegistrations, manifest: { id: 'bases', version: apiVersion } }
      : null,
  };
  constructor() { this.scope = new Scope(); }
  isDarkMode(): boolean { return document.documentElement.dataset.theme === 'dark' || document.body.classList.contains('theme-dark'); }
  loadLocalStorage(key: string): any | null {
    try {
      const raw = localStorage.getItem(this.localStorageKey(key));
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  }
  saveLocalStorage(key: string, data: unknown | null): void {
    try {
      const storageKey = this.localStorageKey(key);
      if (data === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(data));
    } catch { /* quota/private-mode failures are non-fatal */ }
  }
  private localStorageKey(key: string): string { return `webobsidian:${this.vault.getName()}:${key}`; }
}

// ---- Icons + utilities ----------------------------------------------------

export function addIcon(iconId: string, svgContent: string): void { iconRegistry.set(iconId, svgContent); }
export function removeIcon(iconId: string): void { iconRegistry.delete(iconId); }
const builtInIconIds = [
  'alert-circle', 'arrow-left', 'arrow-right', 'bar-chart-3', 'bookmark', 'calendar', 'calendar-days', 'check',
  'check-circle', 'chevron-down', 'chevron-left', 'chevron-right', 'chevron-up',
  'check-square', 'circle', 'clock', 'columns-3', 'file', 'file-text', 'flag', 'folder', 'help-circle', 'image',
  'info', 'link', 'list', 'menu', 'minus', 'minus-circle', 'more-horizontal',
  'pause', 'pencil', 'play', 'plus', 'search', 'settings', 'square', 'star',
  'tag', 'timer', 'trash', 'waypoints', 'x', 'x-circle',
];
const builtInIconSvg: Record<string, string> = {
  calendar: '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  'calendar-days': '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  'check-square': '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  'columns-3': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18M15 3v18"/>',
  timer: '<path d="M10 2h4M12 14v-4M4 13a8 8 0 1 0 8-8 7.9 7.9 0 0 0-4.9 1.7L4 10"/>',
  'bar-chart-3': '<path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3"/>',
};
export function getIconIds(): string[] { return [...new Set([...builtInIconIds, ...iconRegistry.keys()])]; }
export function getIcon(iconId: string): SVGSVGElement | null {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const registered = iconRegistry.get(iconId);
  svg.setAttribute('viewBox', registered ? '0 0 100 100' : '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.innerHTML = registered ?? builtInIconSvg[iconId] ?? '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>';
  return svg;
}
export function setIcon(parent: HTMLElement, iconId: string): void { parent.replaceChildren(getIcon(iconId)!); parent.dataset.icon = iconId; }
export function normalizePath(path: string): string { return path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/'); }
export function getLinkpath(linktext: string): string { return linktext.split('#')[0]; }
export function parseLinktext(linktext: string): { path: string; subpath: string } { const index = linktext.search(/[#^]/); return index < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, index), subpath: linktext.slice(index) }; }
export function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
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

const sharedApp = new App();

export const Keymap = {
  isModEvent(event: KeyboardEvent | MouseEvent): boolean { return Platform.isMacOS ? event.metaKey : event.ctrlKey; },
  isModifier(modifier: string): boolean { return ['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt'].includes(modifier); },
};
export const apiVersion = '1.13.1';
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
export function getLanguage(): string {
  let configured = '';
  try { configured = localStorage.getItem('language') ?? ''; } catch { /* storage may be disabled */ }
  const raw = (configured || document.documentElement.lang || navigator.language || 'en').replaceAll('_', '-');
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('pt-br')) return 'pt-BR';
  return lower.split('-')[0] || 'en';
}

export function prepareSimpleSearch(query: string): (text: string) => any | null {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (text: string) => {
    const lower = text.toLocaleLowerCase();
    const matches: Array<[number, number]> = [];
    let score = 0;
    for (const term of terms) {
      const index = lower.indexOf(term);
      if (index < 0) return null;
      matches.push([index, index + term.length]);
      score += index;
    }
    return { score, matches };
  };
}

export function prepareFuzzySearch(query: string): (text: string) => any | null {
  const needle = query.toLocaleLowerCase().replace(/\s+/g, '');
  if (!needle) return () => ({ score: 0, matches: [] });
  return (text: string) => {
    const haystack = text.toLocaleLowerCase();
    const positions: number[] = [];
    let cursor = 0;
    for (const char of needle) {
      const index = haystack.indexOf(char, cursor);
      if (index < 0) return null;
      positions.push(index);
      cursor = index + 1;
    }
    const matches: Array<[number, number]> = [];
    for (const position of positions) {
      const last = matches[matches.length - 1];
      if (last && last[1] === position) last[1] = position + 1;
      else matches.push([position, position + 1]);
    }
    const gaps = positions.at(-1)! - positions[0] - positions.length + 1;
    return { score: positions[0] + Math.max(0, gaps), matches };
  };
}

export function renderMatches(
  el: HTMLElement | DocumentFragment,
  text: string,
  matches: Array<[number, number]> | null,
  offset = 0,
): void {
  el.replaceChildren();
  if (!matches?.length) { el.appendChild(document.createTextNode(text)); return; }
  let cursor = 0;
  for (const [rawFrom, rawTo] of matches) {
    const from = Math.max(cursor, rawFrom - offset);
    const to = Math.min(text.length, rawTo - offset);
    if (from > cursor) el.appendChild(document.createTextNode(text.slice(cursor, from)));
    if (to > from) {
      const mark = document.createElement('span');
      mark.className = 'suggestion-highlight';
      mark.textContent = text.slice(from, to);
      el.appendChild(mark);
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
}

export function renderResults(el: HTMLElement, text: string, result: any, offset = 0): void {
  renderMatches(el, text, result?.matches ?? null, offset);
}

export function htmlToMarkdown(input: string | HTMLElement | Document | DocumentFragment): string {
  const root = typeof input === 'string'
    ? new DOMParser().parseFromString(input, 'text/html').body
    : input instanceof Document ? input.body : input;
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return [...node.childNodes].map(walk).join('');
    const content = [...node.childNodes].map(walk).join('');
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${content}**`;
    if (tag === 'em' || tag === 'i') return `*${content}*`;
    if (tag === 'del' || tag === 's') return `~~${content}~~`;
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${content}\``;
    if (tag === 'pre') return `\n\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n`;
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === 'a') return `[${content}](${node.getAttribute('href') ?? ''})`;
    if (tag === 'img') return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`;
    if (tag === 'li') return `- ${content.trim()}\n`;
    if (tag === 'blockquote') return `${content.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
    if (['p', 'div', 'section', 'article', 'ul', 'ol'].includes(tag)) return `${content.trimEnd()}\n\n`;
    return content;
  };
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

let pdfJsPromise: Promise<any> | null = null;
export function loadPdfJs(): Promise<any> {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      (globalThis as any).pdfjsLib = pdfjs;
      return pdfjs;
    });
  }
  return pdfJsPromise;
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
export function parseFrontMatterEntry(frontmatter: any, key: string | RegExp): any | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null;
  if (typeof key === 'string') return Object.prototype.hasOwnProperty.call(frontmatter, key) ? frontmatter[key] : null;
  const match = Object.keys(frontmatter).find((name) => { key.lastIndex = 0; return key.test(name); });
  return match === undefined ? null : frontmatter[match];
}
export function parseFrontMatterStringArray(frontmatter: any, key: string | RegExp): string[] | null {
  const value = parseFrontMatterEntry(frontmatter, key);
  return value == null ? null : (Array.isArray(value) ? value : [value]).map(String);
}
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
  // CommonJS/ESM interop helpers emitted by bundlers probe this marker before
  // reading named exports. It is module metadata, not an Obsidian API member.
  __esModule: true,
  App, Plugin, BaseComponent, Component, Events, Notice, Modal, ConfirmationModal, ConfirmationButton,
  PopoverSuggest, AbstractInputSuggest, EditorSuggest, SuggestModal, FuzzySuggestModal,
  Menu, MenuItem, Setting, SettingGroup, SettingPage, PluginSettingTab,
  TextComponent, TextAreaComponent, SearchComponent, ToggleComponent,
  DropdownComponent, ButtonComponent, ExtraButtonComponent, SliderComponent, ColorComponent,
  TAbstractFile, TFile, TFolder, Vault, FileSystemAdapter, MetadataCache,
  Workspace, WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceLeaf,
  View, ItemView, FileView, TextFileView, MarkdownView, MarkdownPreviewView, Editor, FileManager,
  MarkdownRenderer, MarkdownRenderChild, editorEditorField, editorInfoField, editorLivePreviewField,
  Platform, Keymap, Scope, moment, apiVersion, parseYaml, stringifyYaml,
  addIcon, removeIcon, getIcon, getIconIds, setIcon, normalizePath, getLinkpath, parseLinktext,
  arrayBufferToBase64, base64ToArrayBuffer, clamp, debounce, requireApiVersion, request, requestUrl,
  createEl, createDiv, createSpan, createFragment, setTooltip, sanitizeHTMLToDom,
  getAllTags, getLanguage, htmlToMarkdown, loadPdfJs, prepareFuzzySearch, prepareSimpleSearch,
  renderMatches, renderResults, parseFrontMatterAliases, parseFrontMatterEntry,
  parseFrontMatterStringArray, parseFrontMatterTags, getFrontMatterInfo,
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

const externalModules: Record<string, any> = {
  '@codemirror/autocomplete': CodeMirrorAutocomplete,
  '@codemirror/commands': CodeMirrorCommands,
  '@codemirror/language': CodeMirrorLanguage,
  '@codemirror/state': CodeMirrorState,
  '@codemirror/view': CodeMirrorView,
  '@lezer/lr': LezerLR,
  react: ReactModule,
  'ajv-formats/dist/formats': AjvFormats,
  'ajv-formats/dist/formats.js': AjvFormats,
  'ajv/dist/runtime/equal': { default: AjvEqual },
  'ajv/dist/runtime/equal.js': { default: AjvEqual },
  'ajv/dist/runtime/ucs2length': { default: AjvUcs2Length },
  'ajv/dist/runtime/ucs2length.js': { default: AjvUcs2Length },
  'ajv/dist/runtime/uri': { default: AjvUri },
  'ajv/dist/runtime/uri.js': { default: AjvUri },
  'ajv/dist/runtime/validation_error': { default: AjvValidationError },
  'ajv/dist/runtime/validation_error.js': { default: AjvValidationError },
};
const obsidianModuleProxies = new Map<string, Record<string, any>>();
const nodeModules = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'electron', 'fs', 'http', 'http2',
  'module', 'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'zlib',
]);

function obsidianModuleFor(pluginId: string): Record<string, any> {
  let proxy = obsidianModuleProxies.get(pluginId);
  if (proxy) return proxy;
  proxy = new Proxy(obsidianModule, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target) return Reflect.get(target, property, receiver);
      throw new Error(`Plugin "${pluginId}" requires unsupported Obsidian API "${property}"`);
    },
  });
  obsidianModuleProxies.set(pluginId, proxy);
  return proxy;
}

globalThis.__webObsidianRequire = (pluginId: string, moduleName: string) => {
  if (moduleName === 'obsidian') return obsidianModuleFor(pluginId);
  if (Object.prototype.hasOwnProperty.call(externalModules, moduleName)) return externalModules[moduleName];
  if (nodeModules.has(moduleName) || moduleName.startsWith('node:')) {
    throw new Error(`Plugin "${pluginId}" requires Node/Electron module "${moduleName}", which is unavailable on the web`);
  }
  throw new Error(`Plugin "${pluginId}" requires unsupported browser module "${moduleName}"`);
};

async function loadPlugin(id: string, manifest: any, bustCache = false): Promise<void> {
  if (loaded.has(id)) return;
  if (manifest.isDesktopOnly) {
    setPluginState({ id, name: manifest.name, status: 'incompatible', message: 'Desktop-only plugin (requires Node/Electron)' });
    return;
  }
  if (manifest.minAppVersion && !requireApiVersion(manifest.minAppVersion)) {
    setPluginState({
      id,
      name: manifest.name,
      status: 'incompatible',
      message: `Requires Obsidian API ${manifest.minAppVersion}; WebObsidian targets ${apiVersion}`,
    });
    return;
  }
  setPluginState({ id, name: manifest.name, status: 'loading' });
  let instance: Plugin | undefined;
  try {
    const query = new URLSearchParams({ v: String(manifest.version ?? '0'), ...(bustCache ? { reload: String(Date.now()) } : {}) });
    const module = await import(/* @vite-ignore */ `/api/plugins/${encodeURIComponent(id)}/module.js?${query}`);
    const PluginClass = module.default;
    if (typeof PluginClass !== 'function') throw new Error('main.js does not export a Plugin class');
    const fullManifest = { ...manifest, dir: manifest.dir ?? `.obsidian/plugins/${id}` };
    const pluginInstance = new PluginClass(sharedApp, fullManifest) as Plugin;
    instance = pluginInstance;
    pluginInstances[id] = pluginInstance;
    pluginManifests[id] = fullManifest;
    sharedApp.plugins.enabledPlugins.add(id);
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
    queueMicrotask(() => sharedApp.metadataCache.trigger('resolved'));
    setPluginState({ id, name: manifest.name, status: 'loaded', loadedAt: Date.now() });
    console.info(`[plugin] loaded ${id}`);
  } catch (error: any) {
    try { instance?.unload(); } catch { /* best effort */ }
    delete pluginInstances[id];
    delete pluginManifests[id];
    sharedApp.plugins.enabledPlugins.delete(id);
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
  delete pluginInstances[id];
  delete pluginManifests[id];
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
export function initializePluginRuntime(): void {
  installDomHelpers();
  subscribeStoreEvents();
}

export function getPluginApp(): App { return sharedApp; }

/** Load all enabled plugins. Failed plugins remain visible with diagnostics. */
export async function loadPlugins(): Promise<void> {
  initializePluginRuntime();
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

export async function enablePlugin(id: string): Promise<boolean> {
  const { reloadRequired } = await api.setPluginEnabled(id, true);
  if (reloadRequired) {
    window.location.reload();
    return true;
  }
  const manifest = (await api.listPlugins()).plugins.find((plugin: any) => plugin.id === id);
  if (!manifest) throw new Error('Plugin is not installed');
  await loadPlugin(id, { ...manifest, enabled: true }, true);
  return false;
}

export async function disablePlugin(id: string): Promise<boolean> {
  const { reloadRequired } = await api.setPluginEnabled(id, false);
  await unloadPlugin(id);
  const current = pluginStates.get(id);
  setPluginState({ id, name: current?.name ?? id, status: 'disabled' });
  if (reloadRequired) window.location.reload();
  return reloadRequired;
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
