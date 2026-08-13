import { describe, expect, it } from 'vitest';
import { evaluate, evaluateFilter, formatDate, type BaseEvalContext } from './basesExpr';

/** 2026-08-06 12:00 local — matches the screenshots the work was based on. */
const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

function ctx(values: Record<string, unknown>): BaseEvalContext {
  return {
    now: NOW,
    resolve: (path) => (path in values ? (values[path] as never) : undefined as never),
  };
}

describe('Bases expression evaluator', () => {
  it('evaluates comparisons and nested if() chains', () => {
    const priority = 'if(priority=="none",0,if(priority=="low",1,if(priority=="normal",2,if(priority=="high",3,999))))';
    expect(evaluate(priority, ctx({ priority: 'high' }))).toBe(3);
    expect(evaluate(priority, ctx({ priority: 'none' }))).toBe(0);
    expect(evaluate(priority, ctx({ priority: 'weird' }))).toBe(999);
  });

  it('handles isEmpty() on missing and present properties', () => {
    expect(evaluate('due.isEmpty()', ctx({ due: null }))).toBe(true);
    expect(evaluate('due.isEmpty()', ctx({ due: '2026-08-07' }))).toBe(false);
    expect(evaluate('(due.isEmpty() == false)', ctx({ due: '2026-08-07' }))).toBe(true);
  });

  it('does date arithmetic with duration strings', () => {
    const week = evaluate('(today() + "7 days").format("YYYY-MM-DD")', ctx({}));
    expect(week).toBe('2026-08-13');
    expect(evaluate('date(due) < today()', ctx({ due: '2026-08-01' }))).toBe(true);
    expect(evaluate('date(due) < today()', ctx({ due: '2026-08-20' }))).toBe(false);
  });

  it('computes daysUntilDue the way the shipped .base file does', () => {
    const expr = 'if((due.isEmpty() == false), ((number(date(due)) - number(today())) / 86400000).floor(), null)';
    expect(evaluate(expr, ctx({ due: '2026-08-06' }))).toBe(0);
    expect(evaluate(expr, ctx({ due: '2026-08-07' }))).toBe(1);
    expect(evaluate(expr, ctx({ due: '2026-08-04' }))).toBe(-2);
    expect(evaluate(expr, ctx({ due: null }))).toBeNull();
  });

  it('supports bracketed literals in date formats', () => {
    expect(evaluate('date(due).format("YYYY-[W]WW")', ctx({ due: '2026-08-06' }))).toBe('2026-W32');
  });

  it('evaluates list pipelines with the implicit value binding', () => {
    const entries = [
      { startTime: '2026-08-06T08:00:00', endTime: '2026-08-06T09:00:00' },
      { startTime: '2026-08-06T10:00:00', endTime: null },
    ];
    const expr = 'list(timeEntries).filter(value.endTime).map((number(date(value.endTime)) - number(date(value.startTime))) / 60000).reduce(acc + value, 0)';
    expect(evaluate(expr, ctx({ timeEntries: entries }))).toBe(60);
  });

  it('treats string concatenation and numeric addition distinctly', () => {
    expect(evaluate('formula.daysUntilDue + " days"', ctx({ 'formula.daysUntilDue': 3 }))).toBe('3 days');
    expect(evaluate('1 + 2', ctx({}))).toBe(3);
  });

  it('resolves dotted property paths', () => {
    expect(evaluate('file.name', ctx({ 'file.name': 'Test task' }))).toBe('Test task');
    expect(evaluate('file.ctime.format("YYYY-MM")', ctx({ 'file.ctime': '2026-07-30' }))).toBe('2026-07');
  });

  it('evaluates and/or/not filter trees', () => {
    const values = ctx({ status: 'open', due: '2026-08-01' });
    expect(evaluateFilter({ and: ['status != "done"'] }, values)).toBe(true);
    expect(evaluateFilter({ and: ['status == "done"'] }, values)).toBe(false);
    expect(evaluateFilter({ or: ['status == "done"', 'due < today()'] }, values)).toBe(true);
    expect(evaluateFilter({ not: ['status != "done"'] }, values)).toBe(false);
    expect(evaluateFilter(undefined, values)).toBe(true);
  });

  it('returns null instead of throwing on malformed input', () => {
    expect(evaluate('if(', ctx({}))).toBeNull();
    expect(evaluate('&&&', ctx({}))).toBeNull();
  });

  it('formats dates with the moment tokens .base files use', () => {
    const d = new Date(2026, 7, 6, 14, 5, 9);
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-08-06');
    expect(formatDate(d, 'ddd')).toBe('Thu');
    expect(formatDate(d, 'MMM D')).toBe('Aug 6');
    expect(formatDate(d, 'HH:mm:ss')).toBe('14:05:09');
  });
});
