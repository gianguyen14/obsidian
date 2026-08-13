import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBaseDefinition } from './bases';
import { buildBasesData, createQueryController, createViewConfig, type BasesSourceFile } from './basesRuntime';
import type { ObsidianFileCache } from './api';

/** 2026-08-06 12:00 local — the week shown in the reference screenshots. */
const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

function cache(frontmatter: Record<string, unknown>, tags: string[] = []): ObsidianFileCache {
  return {
    frontmatter,
    tags: tags.map((tag) => ({ tag, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } })),
    headings: [],
    links: [],
    embeds: [],
    listItems: [],
    sections: [],
  } as unknown as ObsidianFileCache;
}

function file(path: string, frontmatter: Record<string, unknown>, tags: string[] = ['#task']): BasesSourceFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path,
    name,
    extension: 'md',
    stat: { size: 100, ctime: NOW - 86400000, mtime: NOW },
    cache: cache(frontmatter, tags),
  };
}

const definition = parseBaseDefinition(`
filters:
  and:
    - file.hasTag("task")
formulas:
  daysUntilDue: 'if((due.isEmpty() == false), ((number(date(due)) - number(today())) / 86400000).floor(), null)'
  isOverdue: 'if((due.isEmpty() == false), date(due) < today(), false)'
views:
  - type: tasknotesCalendar
    name: Calendar
    order:
      - file.name
      - due
    sort:
      - column: due
        direction: ASC
    options:
      calendarView: timeGridWeek
      slotDuration: "00:30:00"
      firstDay: 0
      showScheduled: true
`).definition;

const view = definition.views[0];

describe('Bases runtime', () => {
  it('keeps only notes matching the base filter', () => {
    const files = [
      file('Tasks/Write report.md', { due: '2026-08-07', status: 'open' }),
      file('Notes/Not a task.md', { due: '2026-08-07' }, ['#note']),
    ];
    const { entries } = buildBasesData(definition, view, files, NOW);
    expect(entries.map((entry) => entry.file.path)).toEqual(['Tasks/Write report.md']);
  });

  it('matches nested tags and ignores a leading hash', () => {
    const files = [file('A.md', {}, ['#task/work']), file('B.md', {}, ['task']), file('C.md', {}, ['#project'])];
    const { entries } = buildBasesData(definition, view, files, NOW);
    expect(entries.map((entry) => entry.file.basename)).toEqual(['A', 'B']);
  });

  it('caches formula outputs where consumers read them', () => {
    const files = [file('T.md', { due: '2026-08-08' })];
    const { entries } = buildBasesData(definition, view, files, NOW);
    const entry = entries[0];
    expect(entry.formulaResults.cachedFormulaOutputs.daysUntilDue).toBe(2);
    expect(entry.formulaResults.cachedFormulaOutputs.isOverdue).toBe(false);
    expect(entry.getValue('formula.daysUntilDue').data).toBe(2);
  });

  it('exposes formulas through ctx for lazy evaluation', () => {
    const files = [file('T.md', { due: '2026-08-04' })];
    const { data, entries } = buildBasesData(definition, view, files, NOW);
    expect(data.ctx.formulas.daysUntilDue.getValue(entries[0])).toBe(-2);
    expect(data.ctx.formulas.isOverdue.getValue(entries[0])).toBe(true);
  });

  it('resolves file and note fields via getValue with string ids', () => {
    const files = [file('Tasks/Write report.md', { due: '2026-08-07', status: 'open' })];
    const { entries } = buildBasesData(definition, view, files, NOW);
    const entry = entries[0];
    expect(entry.getValue('file.path').data).toBe('Tasks/Write report.md');
    expect(entry.getValue('file.name').data).toBe('Write report');
    expect(entry.getValue('note.status').data).toBe('open');
    expect(entry.getValue('status').data).toBe('open');
    expect(entry.getValue('file.ctime').data).toBeInstanceOf(Date);
    expect(entry.getValue('note.missing').data).toBeNull();
  });

  it('sorts by the view sort rule and puts empty values last', () => {
    const files = [
      file('c.md', { due: '2026-08-09' }),
      file('a.md', {}),
      file('b.md', { due: '2026-08-07' }),
    ];
    const { entries } = buildBasesData(definition, view, files, NOW);
    expect(entries.map((entry) => entry.file.basename)).toEqual(['b', 'c', 'a']);
  });

  it('returns exactly one keyless group when not grouped', () => {
    const files = [file('a.md', { due: '2026-08-07' })];
    const { data } = buildBasesData(definition, view, files, NOW);
    expect(data.groupedData).toHaveLength(1);
    expect(data.groupedData[0].hasKey()).toBe(false);
    expect(data.groupedData[0].entries).toHaveLength(1);
  });

  it('groups by a property and always yields at least one group', () => {
    const grouped = { ...view, groupBy: 'status' };
    const files = [
      file('a.md', { status: 'open' }),
      file('b.md', { status: 'done' }),
      file('c.md', { status: 'open' }),
    ];
    const { data } = buildBasesData(definition, grouped, files, NOW);
    expect(data.groupedData.map((group) => String(group.key))).toEqual(['open', 'done']);
    expect(data.groupedData.every((group) => group.hasKey())).toBe(true);

    const empty = buildBasesData(definition, grouped, [], NOW);
    expect(empty.data.groupedData).toHaveLength(1);
    expect(empty.data.groupedData[0].hasKey()).toBe(false);
  });

  it('reads view options through config.get, directly and via options', () => {
    const config = createViewConfig(definition, view, () => { });
    expect(config.get('calendarView')).toBe('timeGridWeek');
    expect((config.get('options') as Record<string, unknown>).slotDuration).toBe('00:30:00');
    expect(config.get('showScheduled')).toBe(true);
    expect(config.getOrder()).toEqual(['file.name', 'due']);
    expect(config.getSort()[0]).toMatchObject({ property: 'due', direction: 'ASC' });
  });

  it('reports config edits and prefers overrides afterwards', () => {
    const seen: [string, unknown][] = [];
    const config = createViewConfig(definition, view, (key, value) => seen.push([key, value]));
    config.set('calendarView', 'dayGridMonth');
    expect(seen).toEqual([['calendarView', 'dayGridMonth']]);
    expect(config.get('calendarView')).toBe('dayGridMonth');
  });

  it('gives the controller a writable onConfigChanged that views can patch', () => {
    const controller = createQueryController(definition, view);
    expect(typeof controller.onConfigChanged).toBe('function');
    expect(Object.prototype.hasOwnProperty.call(controller, 'onConfigChanged')).toBe(true);
    let called = false;
    controller.onConfigChanged = () => { called = true; return undefined; };
    controller.onConfigChanged();
    expect(called).toBe(true);
    expect(controller.viewName).toBe('Calendar');
  });

  it('survives a formula that references itself', () => {
    const recursive = parseBaseDefinition(`
formulas:
  loop: 'formula.loop + 1'
views:
  - type: table
    name: T
`).definition;
    const { entries } = buildBasesData(recursive, recursive.views[0], [file('a.md', {})], NOW);
    expect(entries).toHaveLength(1);
    expect(() => entries[0].getValue('formula.loop')).not.toThrow();
  });

  it('runs the real shipped calendar-default.base end to end', () => {
    const source = readFileSync(new URL('../../../vault/TaskNotes/Views/calendar-default.base', import.meta.url), 'utf8');
    const parsed = parseBaseDefinition(source);
    expect(parsed.error).toBe('');
    const calendarView = parsed.definition.views[0];
    expect(calendarView.type).toBe('tasknotesCalendar');

    const files = [
      file('Tasks/Meeting.md', { title: 'Meeting', due: '2026-08-06', scheduled: '2026-08-06T09:00:00', status: 'open', priority: 'high' }),
      file('Tasks/Later.md', { title: 'Later', due: '2026-08-20', status: 'open', priority: 'low' }),
      file('Notes/Plain.md', { title: 'Plain' }, ['#note']),
    ];
    const { data, entries } = buildBasesData(parsed.definition, calendarView, files, NOW);

    // The '#note' file must be filtered out by file.hasTag("task").
    expect(entries.map((entry) => entry.file.basename).sort()).toEqual(['Later', 'Meeting']);
    // The renderer needs a group to iterate and real date values to place events.
    expect(data.groupedData.length).toBeGreaterThanOrEqual(1);
    const meeting = entries.find((entry) => entry.file.basename === 'Meeting');
    expect(meeting?.getValue('scheduled').data).toBe('2026-08-06T09:00:00');
    expect(meeting?.getValue('due').data).toBe('2026-08-06');
    // Formulas from the real file must produce values, not nulls.
    expect(Object.keys(meeting?.formulaResults.cachedFormulaOutputs ?? {}).length).toBeGreaterThan(0);

    const config = createViewConfig(parsed.definition, calendarView, () => { });
    expect(config.get('calendarView')).toBe('timeGridWeek');
    expect(config.get('slotDuration')).toBe('00:30:00');
  });
});
