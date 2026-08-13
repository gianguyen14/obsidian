import { parse as parseYaml } from 'yaml';

export interface BaseSortRule {
  column: string;
  direction: 'ASC' | 'DESC';
}
export interface BaseViewDefinition {
  type: string;
  name: string;
  order: string[];
  sort: BaseSortRule[];
  filters?: unknown;
  groupBy?: { property?: string; direction?: string } | string;
  config?: Record<string, unknown>;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BaseDefinition {
  filters?: unknown;
  formulas: Record<string, unknown>;
  properties: Record<string, { displayName?: string } | unknown>;
  newItemFolder?: string;
  newItemTemplate?: string;
  views: BaseViewDefinition[];
}

export interface ParsedBaseDefinition {
  definition: BaseDefinition;
  error: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeSort(value: unknown): BaseSortRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rule = asRecord(item);
    const column = typeof rule.column === 'string'
      ? rule.column
      : typeof rule.property === 'string'
        ? rule.property
        : '';
    if (!column) return [];
    return [{
      column,
      direction: String(rule.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
    } satisfies BaseSortRule];
  });
}

function normalizeView(value: unknown, index: number): BaseViewDefinition {
  const view = asRecord(value);
  const name = typeof view.name === 'string' && view.name.trim() ? view.name.trim() : `View ${index + 1}`;
  return {
    ...view,
    type: typeof view.type === 'string' && view.type.trim() ? view.type.trim() : 'table',
    name,
    order: asStringArray(view.order),
    sort: normalizeSort(view.sort),
    filters: view.filters,
    groupBy: typeof view.groupBy === 'string' ? view.groupBy : asRecord(view.groupBy),
    config: asRecord(view.config),
    options: asRecord(view.options),
  };
}

export function parseBaseDefinition(source: string): ParsedBaseDefinition {
  try {
    const parsed = source.trim() ? asRecord(parseYaml(source)) : {};
    const views = Array.isArray(parsed.views)
      ? parsed.views.map(normalizeView)
      : [normalizeView({ type: 'table', name: 'Table' }, 0)];
    return {
      definition: {
        filters: parsed.filters,
        formulas: asRecord(parsed.formulas),
        properties: asRecord(parsed.properties),
        newItemFolder: typeof parsed.newItemFolder === 'string' ? parsed.newItemFolder : undefined,
        newItemTemplate: typeof parsed.newItemTemplate === 'string' ? parsed.newItemTemplate : undefined,
        views: views.length ? views : [normalizeView({ type: 'table', name: 'Table' }, 0)],
      },
      error: '',
    };
  } catch (error) {
    return {
      definition: {
        formulas: {},
        properties: {},
        views: [normalizeView({ type: 'table', name: 'Table' }, 0)],
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function basePropertyLabel(definition: BaseDefinition, property: string): string {
  const configured = asRecord(definition.properties[property]);
  if (typeof configured.displayName === 'string' && configured.displayName.trim()) {
    return configured.displayName.trim();
  }
  const bare = property.replace(/^(?:note|task|file|formula)\./, '');
  return bare
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

export function describeBaseFilters(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(describeBaseFilters);
  const record = asRecord(value);
  const lines: string[] = [];
  for (const operator of ['and', 'or', 'not'] as const) {
    if (!(operator in record)) continue;
    const nested = describeBaseFilters(record[operator]);
    if (!nested.length) continue;
    const label = operator === 'and' ? 'All' : operator === 'or' ? 'Any' : 'Not';
    lines.push(...nested.map((line) => `${label}: ${line}`));
  }
  return lines;
}

/** Return the first tag used by a standard Bases file.hasTag() filter. */
export function getBaseFilterTag(definition: BaseDefinition, view: BaseViewDefinition): string {
  const expressions = [
    ...describeBaseFilters(definition.filters),
    ...describeBaseFilters(view.filters),
  ];
  for (const expression of expressions) {
    const match = /file\.hasTag\(\s*["']#?([^"']+)["']\s*\)/i.exec(expression);
    if (match?.[1]) return match[1];
  }
  return view.type.startsWith('tasknotes') ? 'task' : '';
}
