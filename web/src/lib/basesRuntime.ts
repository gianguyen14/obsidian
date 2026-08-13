import {
  evaluate,
  evaluateFilter,
  isEmptyValue,
  parseDateValue,
  type BaseEvalContext,
  type BaseValue,
} from './basesExpr';
import type { BaseDefinition, BaseViewDefinition } from './bases';
import type { ObsidianFileCache } from './api';

/**
 * Runtime for Obsidian Bases: turns a parsed `.base` definition plus the vault
 * metadata cache into the objects a registered Bases view expects.
 *
 * Shape notes (derived from the TaskNotes bundle, which is the main real-world
 * consumer): Bases does not hand the view a fat controller. It injects
 * `view.data`, `view.config` and `view.app` onto the instance the factory
 * returned, then calls `view.onDataUpdated()`. The controller itself only needs
 * `onConfigChanged` (which views monkey-patch), plus `viewName`/`query` for
 * group-by lookups. Keep this in sync with those expectations.
 */

export interface BasesFileInfo {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat: { size: number; ctime: number; mtime: number };
}

/** Values are wrapped: consumers unwrap via `.data` (or the documented fallbacks). */
export class BasesValue {
  constructor(readonly data: BaseValue) { }
  toString(): string {
    if (this.data == null) return '';
    if (this.data instanceof Date) return this.data.toISOString();
    if (Array.isArray(this.data)) return this.data.map(String).join(', ');
    return String(this.data);
  }
  get date(): Date | null { return parseDateValue(this.data); }
  get length(): number { return Array.isArray(this.data) ? this.data.length : 0; }
  get(index: number): BaseValue { return Array.isArray(this.data) ? this.data[index] ?? null : null; }
  isEmpty(): boolean { return isEmptyValue(this.data); }
}

export class NullValue extends BasesValue {
  constructor() { super(null); }
}

const wrap = (value: BaseValue): BasesValue => (value == null ? new NullValue() : new BasesValue(value));

export interface BasesEntry {
  file: BasesFileInfo;
  path: string;
  frontmatter: Record<string, unknown>;
  properties: Record<string, unknown>;
  formulaResults: { cachedFormulaOutputs: Record<string, unknown> };
  getValue(propertyId: string): BasesValue;
  /** Raw (unwrapped) lookup used internally by filters, sorting and grouping. */
  raw(propertyId: string): BaseValue;
}

export interface BasesGroup {
  key: BasesValue;
  entries: BasesEntry[];
  hasKey(): boolean;
}

export interface BasesData {
  data: BasesEntry[];
  groupedData: BasesGroup[];
  ctx: { formulas: Record<string, { getValue(entry: BasesEntry): unknown }> };
}

export interface BasesViewConfig {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getOrder(): string[];
  getSort(): { property?: string; column?: string; direction?: string }[];
  getDisplayName(propertyId: string): string;
  getAsPropertyId(key: string): string | null;
}

/** Source note used to build entries. */
export interface BasesSourceFile {
  path: string;
  name: string;
  extension: string;
  stat: { size: number; ctime: number; mtime: number };
  cache: ObsidianFileCache | null;
}

const stripExt = (name: string) => name.replace(/\.[^./]+$/, '');

/** Tags from a file cache, normalized without the leading '#'. */
function cacheTags(cache: ObsidianFileCache | null): string[] {
  if (!cache) return [];
  const out = new Set<string>();
  for (const entry of cache.tags ?? []) {
    const tag = entry.tag.replace(/^#/, '').trim();
    if (tag) out.add(tag);
  }
  return [...out];
}

/**
 * Build one entry. Property lookups accept the prefixed ids Bases uses
 * (`note.due`, `file.name`, `formula.dueIn`) as well as bare frontmatter keys,
 * because `.base` filters routinely write `status != "done"` with no prefix.
 */
export function createEntry(file: BasesSourceFile, now: number): BasesEntry {
  const frontmatter = (file.cache?.frontmatter ?? {}) as Record<string, unknown>;
  const tags = cacheTags(file.cache);
  const basename = stripExt(file.name);
  const info: BasesFileInfo = {
    path: file.path,
    name: file.name,
    basename,
    extension: file.extension,
    stat: file.stat,
  };
  const formulaResults = { cachedFormulaOutputs: {} as Record<string, unknown> };

  const fileValue = (key: string): BaseValue | undefined => {
    switch (key) {
      case 'path': return file.path;
      case 'name': return basename;
      case 'basename': return basename;
      case 'ext': case 'extension': return file.extension;
      case 'folder': return file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      case 'size': return file.stat.size;
      case 'ctime': return file.stat.ctime ? new Date(file.stat.ctime) : null;
      case 'mtime': return file.stat.mtime ? new Date(file.stat.mtime) : null;
      case 'tags': return tags;
      case 'links': return (file.cache?.links ?? []).map((link) => link.link);
      case 'embeds': return (file.cache?.embeds ?? []).map((link) => link.link);
      case 'tasks': return (file.cache?.listItems ?? []).filter((item) => item.task !== undefined).length;
      default: return undefined;
    }
  };

  const fileObject = (): BaseValue => ({
    path: file.path,
    name: basename,
    basename,
    extension: file.extension,
    tags,
    links: (file.cache?.links ?? []).map((link) => link.link),
    embeds: (file.cache?.embeds ?? []).map((link) => link.link),
    properties: frontmatter as Record<string, BaseValue>,
    ctime: file.stat.ctime ? new Date(file.stat.ctime) : null,
    mtime: file.stat.mtime ? new Date(file.stat.mtime) : null,
    size: file.stat.size,
  });

  const raw = (propertyId: string): BaseValue => {
    const id = propertyId.trim();
    if (!id) return null;
    if (id.startsWith('formula.')) {
      const name = id.slice('formula.'.length);
      return (formulaResults.cachedFormulaOutputs[name] ?? null) as BaseValue;
    }
    if (id.startsWith('file.')) {
      const value = fileValue(id.slice('file.'.length));
      return value === undefined ? null : value;
    }
    // Bare `file` / `note` must resolve to objects: filters call methods on them
    // (`file.hasTag(...)`) and read nested keys (`note.blockedBy`).
    if (id === 'file') return fileObject();
    if (id === 'note' || id === 'task') return frontmatter as BaseValue;
    const bare = id.replace(/^(?:note|task)\./, '');
    if (bare in frontmatter) return frontmatter[bare] as BaseValue;
    if (bare === 'tags' || bare === 'tag') return tags;
    // Unprefixed file fields still resolve, matching Bases' implicit lookups.
    const implicit = fileValue(bare);
    return implicit === undefined ? null : implicit;
  };

  return {
    file: info,
    path: file.path,
    frontmatter,
    properties: frontmatter,
    formulaResults,
    getValue: (propertyId: string) => wrap(raw(propertyId)),
    raw,
  };
}

/** Evaluation context for one entry, including formula cross-references. */
function entryContext(
  entry: BasesEntry,
  formulas: Record<string, string>,
  now: number,
  computing = new Set<string>(),
  lookupFile?: (target: string) => BaseValue,
): BaseEvalContext {
  const ctx: BaseEvalContext = {
    now,
    lookupFile,
    resolve: (path: string) => {
      if (path.startsWith('formula.')) {
        const name = path.slice('formula.'.length);
        const cached = entry.formulaResults.cachedFormulaOutputs;
        if (name in cached) return cached[name] as BaseValue;
        // Guard against a formula referencing itself, directly or in a cycle.
        if (computing.has(name) || !(name in formulas)) return null;
        computing.add(name);
        const value = evaluate(formulas[name], entryContext(entry, formulas, now, computing, lookupFile));
        computing.delete(name);
        cached[name] = value;
        return value;
      }
      return entry.raw(path);
    },
  };
  return ctx;
}

/** Evaluate every formula for an entry and cache the outputs. */
export function computeFormulas(
  entry: BasesEntry,
  formulas: Record<string, string>,
  now: number,
  lookupFile?: (target: string) => BaseValue,
): void {
  const cached = entry.formulaResults.cachedFormulaOutputs;
  for (const name of Object.keys(formulas)) {
    if (name in cached) continue;
    cached[name] = evaluate(formulas[name], entryContext(entry, formulas, now, new Set(), lookupFile));
  }
}

function formulaSources(definition: BaseDefinition): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, expression] of Object.entries(definition.formulas ?? {})) {
    if (typeof expression === 'string') out[name] = expression;
  }
  return out;
}

function groupByProperty(view: BaseViewDefinition): string {
  if (typeof view.groupBy === 'string') return view.groupBy;
  const record = view.groupBy as { property?: string } | undefined;
  return typeof record?.property === 'string' ? record.property : '';
}

/** Group label for a value, mirroring Bases' Unknown/None handling. */
function groupKeyValue(value: BaseValue): BasesValue {
  return value == null ? new NullValue() : new BasesValue(value);
}

export interface BuildResult {
  data: BasesData;
  entries: BasesEntry[];
}

/**
 * Apply the base-level and view-level filters, formulas, sort and groupBy to the
 * candidate files and produce the `view.data` payload.
 */
export function buildBasesData(
  definition: BaseDefinition,
  view: BaseViewDefinition,
  files: BasesSourceFile[],
  now: number,
): BuildResult {
  const formulas = formulaSources(definition);
  const entries: BasesEntry[] = [];

  // `file("Some note")` filters need to reach other notes, so index the whole
  // candidate set by basename and by path before evaluating anything.
  const byKey = new Map<string, BasesSourceFile>();
  for (const file of files) {
    const basename = stripExt(file.name).toLowerCase();
    if (!byKey.has(basename)) byKey.set(basename, file);
    byKey.set(file.path.toLowerCase().replace(/\.md$/, ''), file);
  }
  const lookupFile = (target: string): BaseValue => {
    const found = byKey.get(target.toLowerCase());
    if (!found) return null;
    return createEntry(found, now).raw('file');
  };

  for (const file of files) {
    const entry = createEntry(file, now);
    computeFormulas(entry, formulas, now, lookupFile);
    const ctx = entryContext(entry, formulas, now, new Set(), lookupFile);
    if (!evaluateFilter(definition.filters, ctx)) continue;
    if (!evaluateFilter(view.filters, ctx)) continue;
    entries.push(entry);
  }

  for (const rule of [...view.sort].reverse()) {
    const dir = rule.direction === 'DESC' ? -1 : 1;
    entries.sort((a, b) => {
      const av = a.raw(rule.column);
      const bv = b.raw(rule.column);
      // Empty values sort last regardless of direction, as in Obsidian.
      if (isEmptyValue(av) && isEmptyValue(bv)) return 0;
      if (isEmptyValue(av)) return 1;
      if (isEmptyValue(bv)) return -1;
      const ad = parseDateValue(av);
      const bd = parseDateValue(bv);
      if (ad && bd) return (ad.getTime() - bd.getTime()) * dir;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const property = groupByProperty(view);
  let groupedData: BasesGroup[];
  if (property) {
    const buckets = new Map<string, { key: BaseValue; entries: BasesEntry[] }>();
    for (const entry of entries) {
      const value = entry.raw(property);
      const label = value == null ? ' null' : String(value);
      const bucket = buckets.get(label);
      if (bucket) bucket.entries.push(entry);
      else buckets.set(label, { key: value, entries: [entry] });
    }
    groupedData = [...buckets.values()].map((bucket) => ({
      key: groupKeyValue(bucket.key),
      entries: bucket.entries,
      hasKey: () => true,
    }));
    // A grouped view with no rows still needs one group, or isGrouped() lies.
    if (!groupedData.length) groupedData = [{ key: new NullValue(), entries: [], hasKey: () => false }];
  } else {
    // "Not grouped" is exactly one group whose hasKey() is false — an empty
    // array would make the consumer's isGrouped() check return true.
    groupedData = [{ key: new NullValue(), entries, hasKey: () => false }];
  }

  const formulaAccessors: Record<string, { getValue(entry: BasesEntry): unknown }> = {};
  for (const name of Object.keys(formulas)) {
    formulaAccessors[name] = {
      getValue: (entry: BasesEntry) => {
        computeFormulas(entry, formulas, now, lookupFile);
        return entry.formulaResults.cachedFormulaOutputs[name] ?? null;
      },
    };
  }

  return { data: { data: entries, groupedData, ctx: { formulas: formulaAccessors } }, entries };
}

/** Property ids referenced anywhere in the definition, for `allProperties`. */
export function collectProperties(definition: BaseDefinition, entries: BasesEntry[]): string[] {
  const out = new Set<string>();
  for (const view of definition.views) for (const id of view.order) out.add(id);
  for (const name of Object.keys(definition.formulas ?? {})) out.add(`formula.${name}`);
  for (const entry of entries.slice(0, 200)) {
    for (const key of Object.keys(entry.frontmatter)) out.add(`note.${key}`);
  }
  for (const key of ['file.name', 'file.path', 'file.tags', 'file.ctime', 'file.mtime']) out.add(key);
  return [...out];
}

/**
 * Build the `view.config` object. `get()` falls back to the view's `options`
 * map, because consumers read option keys directly (`config.get('calendarView')`)
 * and only then try `config.get('options').calendarView`.
 */
export function createViewConfig(
  definition: BaseDefinition,
  view: BaseViewDefinition,
  onChange: (key: string, value: unknown) => void,
): BasesViewConfig {
  const overrides = new Map<string, unknown>();
  const options = (view.options ?? {}) as Record<string, unknown>;

  return {
    get(key: string) {
      if (overrides.has(key)) return overrides.get(key);
      if (key === 'options') return options;
      if (key in options) return options[key];
      if (key in view) return (view as Record<string, unknown>)[key];
      return undefined;
    },
    set(key: string, value: unknown) {
      overrides.set(key, value);
      onChange(key, value);
    },
    getOrder: () => [...view.order],
    getSort: () => view.sort.map((rule) => ({ property: rule.column, column: rule.column, direction: rule.direction })),
    getDisplayName(propertyId: string) {
      const configured = definition.properties?.[propertyId] as { displayName?: string } | undefined;
      if (configured && typeof configured.displayName === 'string' && configured.displayName.trim()) {
        return configured.displayName.trim();
      }
      return propertyId.replace(/^(?:note|task|file|formula)\./, '');
    },
    getAsPropertyId(key: string) {
      if (!key) return null;
      return /^(?:note|task|file|formula)\./.test(key) ? key : `note.${key}`;
    },
  };
}

/**
 * The controller passed as the factory's first argument. Views patch
 * `onConfigChanged` to hook config edits, so it must be an own, writable
 * function property; `view`/`viewName`/`query` are read for group-by lookups.
 */
export interface BasesQueryController {
  onConfigChanged: (...args: unknown[]) => unknown;
  view: unknown;
  viewName: string;
  query: { views: { name: string; groupBy?: string | { property: string } }[] };
}

export function createQueryController(
  definition: BaseDefinition,
  view: BaseViewDefinition,
): BasesQueryController {
  return {
    // Replaced by the view via monkey-patching; the base implementation is a
    // no-op that simply must exist and be callable.
    onConfigChanged: () => undefined,
    view: undefined,
    viewName: view.name,
    query: {
      views: definition.views.map((item) => ({
        name: item.name,
        groupBy: groupByProperty(item) || undefined,
      })),
    },
  };
}
