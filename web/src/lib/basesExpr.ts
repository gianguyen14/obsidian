/**
 * Evaluator for the Obsidian Bases expression language — the syntax used by
 * `filters:` and `formulas:` in a `.base` file.
 *
 * This is a self-contained Pratt parser plus interpreter rather than a regex
 * pass, because real `.base` files nest calls and operators arbitrarily deeply
 * (see vault/TaskNotes/Views/*.base, whose formulas chain a dozen `if()` calls).
 * Anything unparseable evaluates to `null`, which filters treat as "not
 * matching" so a malformed expression hides rows instead of throwing.
 */

export type BaseValue =
  | string
  | number
  | boolean
  | null
  | BaseValue[]
  | { [key: string]: BaseValue }
  | Date;

export interface BaseEvalContext {
  /** Resolve an identifier path such as `note.due`, `file.name`, `formula.dueIn`. */
  resolve(path: string): BaseValue;
  /** Milliseconds since epoch used for now()/today(); injected for determinism. */
  now: number;
  /**
   * Look up another note by link, path or basename, for the `file(...)`
   * function used by relationship filters. Returns an object exposing at least
   * `path`/`name`/`properties`/`tags`; null when unresolvable or unsupported.
   */
  lookupFile?(target: string): BaseValue;
}

// ---- tokenizer -------------------------------------------------------------

type TokKind = 'num' | 'str' | 'ident' | 'op' | 'eof';
interface Tok { kind: TokKind; value: string; }

const OPS = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??',
  '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '[', ']', ',', '.', '?', ':',
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === '"' || ch === "'") {
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\' && i + 1 < src.length) { value += src[i + 1]; i += 2; continue; }
        value += src[i];
        i += 1;
      }
      i += 1;
      out.push({ kind: 'str', value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let value = '';
      while (i < src.length && /[0-9.]/.test(src[i])) { value += src[i]; i += 1; }
      out.push({ kind: 'num', value });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let value = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) { value += src[i]; i += 1; }
      out.push({ kind: 'ident', value });
      continue;
    }
    const op = OPS.find((candidate) => src.startsWith(candidate, i));
    if (op) { out.push({ kind: 'op', value: op }); i += op.length; continue; }
    i += 1; // skip anything unrecognised
  }
  out.push({ kind: 'eof', value: '' });
  return out;
}

// ---- AST -------------------------------------------------------------------

type Node =
  | { t: 'lit'; v: BaseValue }
  | { t: 'ident'; name: string }
  | { t: 'member'; obj: Node; name: string }
  | { t: 'index'; obj: Node; idx: Node }
  | { t: 'call'; callee: Node; args: Node[] }
  | { t: 'unary'; op: string; arg: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node };

const BINARY_PRECEDENCE: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '>': 5, '<=': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) { }

  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private eat(value: string): boolean {
    if (this.peek().kind === 'op' && this.peek().value === value) { this.pos += 1; return true; }
    return false;
  }

  parse(): Node {
    const node = this.expr(0);
    return node;
  }

  private expr(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'op' && tok.value === '?' && minPrec <= 0) {
        this.next();
        const a = this.expr(0);
        this.eat(':');
        const b = this.expr(0);
        left = { t: 'cond', c: left, a, b };
        continue;
      }
      if (tok.kind !== 'op') break;
      const prec = BINARY_PRECEDENCE[tok.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.expr(prec + 1);
      left = { t: 'bin', op: tok.value, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    const tok = this.peek();
    if (tok.kind === 'op' && (tok.value === '!' || tok.value === '-')) {
      this.next();
      return { t: 'unary', op: tok.value, arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(node: Node): Node {
    let out = node;
    for (;;) {
      if (this.eat('.')) {
        const name = this.next().value;
        out = { t: 'member', obj: out, name };
        continue;
      }
      if (this.eat('(')) {
        const args: Node[] = [];
        if (!this.eat(')')) {
          do { args.push(this.expr(0)); } while (this.eat(','));
          this.eat(')');
        }
        out = { t: 'call', callee: out, args };
        continue;
      }
      if (this.eat('[')) {
        const idx = this.expr(0);
        this.eat(']');
        out = { t: 'index', obj: out, idx };
        continue;
      }
      return out;
    }
  }

  private primary(): Node {
    const tok = this.next();
    if (tok.kind === 'num') return { t: 'lit', v: Number(tok.value) };
    if (tok.kind === 'str') return { t: 'lit', v: tok.value };
    if (tok.kind === 'ident') {
      if (tok.value === 'true') return { t: 'lit', v: true };
      if (tok.value === 'false') return { t: 'lit', v: false };
      if (tok.value === 'null') return { t: 'lit', v: null };
      return { t: 'ident', name: tok.value };
    }
    if (tok.kind === 'op' && tok.value === '(') {
      const inner = this.expr(0);
      this.eat(')');
      return inner;
    }
    if (tok.kind === 'op' && tok.value === '[') {
      const items: Node[] = [];
      if (!this.eat(']')) {
        do { items.push(this.expr(0)); } while (this.eat(','));
        this.eat(']');
      }
      return { t: 'call', callee: { t: 'ident', name: '@array' }, args: items };
    }
    return { t: 'lit', v: null };
  }
}

const astCache = new Map<string, Node | null>();

function parseExpression(src: string): Node | null {
  if (astCache.has(src)) return astCache.get(src) ?? null;
  let node: Node | null = null;
  try {
    node = new Parser(tokenize(src)).parse();
  } catch {
    node = null;
  }
  astCache.set(src, node);
  return node;
}

// ---- value helpers ---------------------------------------------------------

export function isEmptyValue(value: BaseValue): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function toNumber(value: BaseValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const date = parseDateValue(value);
    if (date) return date.getTime();
    const n = Number(value);
    return Number.isNaN(n) ? Number.NaN : n;
  }
  return Number.NaN;
}

export function truthy(value: BaseValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  if (value instanceof Date) return true;
  return Boolean(value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

/** Parse the date shapes Bases accepts, treating date-only values as local midnight. */
export function parseDateValue(value: BaseValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DATE_RE.test(text)) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const d = new Date(dateOnly ? `${text}T00:00:00` : text.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toList(value: BaseValue): BaseValue[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** Read a field off a plain object, or undefined when it isn't one. */
function objectField(value: BaseValue, key: string): BaseValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return undefined;
  const field = (value as Record<string, BaseValue>)[key];
  return field === undefined ? undefined : field;
}

/** Normalize a tag for comparison: no leading '#', case-insensitive. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

/**
 * Reduce a link-ish value to a comparable identity so `asLink()` results and
 * `hasLink()` arguments can be equated. Accepts file objects, wikilinks,
 * markdown links and bare paths; strips the folder and extension because
 * Obsidian links resolve by basename.
 */
function linkTarget(value: BaseValue): string {
  if (value == null) return '';
  const raw = typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? stringify(objectField(value, 'path') ?? objectField(value, 'name') ?? '')
    : stringify(value);
  let text = raw.trim();
  if (!text) return '';
  const md = /^\[[^\]]*\]\((.*)\)$/.exec(text);
  if (md) text = md[1];
  text = text.replace(/^\[\[/, '').replace(/\]\]$/, '');
  text = text.split('|')[0].split('#')[0].trim();
  try { text = decodeURIComponent(text); } catch { /* leave percent-encoding as-is */ }
  text = text.slice(text.lastIndexOf('/') + 1);
  return text.replace(/\.md$/i, '').toLowerCase();
}

function stringify(value: BaseValue): string {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(value, 'YYYY-MM-DD');
  if (Array.isArray(value)) return value.map(stringify).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** moment-style formatting for the subset of tokens `.base` files use. */
export function formatDate(date: Date, pattern: string): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const isoWeek = () => {
    const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  };
  // Bracketed segments are literals in moment syntax: YYYY-[W]WW
  return pattern.replace(/\[([^\]]*)\]|YYYY|MMMM|MMM|MM|DDDD|dddd|ddd|DD|HH|mm|ss|WW|M|D|d|H|w/g, (token, literal) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': return String(date.getFullYear());
      case 'MMMM': return MONTHS[date.getMonth()];
      case 'MMM': return MONTHS[date.getMonth()].slice(0, 3);
      case 'MM': return pad(date.getMonth() + 1);
      case 'M': return String(date.getMonth() + 1);
      case 'DD': return pad(date.getDate());
      case 'D': return String(date.getDate());
      case 'dddd': return DAYS[date.getDay()];
      case 'ddd': return DAYS[date.getDay()].slice(0, 3);
      case 'd': return String(date.getDay());
      case 'HH': return pad(date.getHours());
      case 'H': return String(date.getHours());
      case 'mm': return pad(date.getMinutes());
      case 'ss': return pad(date.getSeconds());
      case 'WW': return pad(isoWeek());
      case 'w': return String(isoWeek());
      default: return token;
    }
  });
}

/** Add/subtract a duration string such as "7 days", "1 day", "-2w", "3h". */
function shiftDate(date: Date, duration: string): Date {
  const out = new Date(date.getTime());
  const re = /(-?\d+(?:\.\d+)?)\s*(years?|y|months?|M|weeks?|w|days?|d|hours?|h|minutes?|m|seconds?|s)/g;
  let matched = false;
  for (const m of duration.matchAll(re)) {
    matched = true;
    const amount = Number(m[1]);
    const unit = m[2];
    if (/^(years?|y)$/.test(unit)) out.setFullYear(out.getFullYear() + amount);
    else if (unit === 'M' || /^months?$/.test(unit)) out.setMonth(out.getMonth() + amount);
    else if (/^(weeks?|w)$/.test(unit)) out.setDate(out.getDate() + amount * 7);
    else if (/^(days?|d)$/.test(unit)) out.setDate(out.getDate() + amount);
    else if (/^(hours?|h)$/.test(unit)) out.setHours(out.getHours() + amount);
    else if (unit === 'm' || /^minutes?$/.test(unit)) out.setMinutes(out.getMinutes() + amount);
    else out.setSeconds(out.getSeconds() + amount);
  }
  return matched ? out : date;
}

/**
 * Date operand test for `+`/`-`. Deliberately stricter than parseDateValue():
 * that accepts plain numbers as epoch millis, which would make `3 + " days"`
 * date arithmetic instead of string concatenation.
 */
function dateOperand(value: BaseValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') return parseDateValue(value);
  return null;
}

function compare(a: BaseValue, b: BaseValue): number {
  const da = parseDateValue(a);
  const db = parseDateValue(b);
  if (da && db) return da.getTime() - db.getTime();
  const na = toNumber(a);
  const nb = toNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return stringify(a).localeCompare(stringify(b));
}

function looseEquals(a: BaseValue, b: BaseValue): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  const da = parseDateValue(a);
  const db = parseDateValue(b);
  if (da && db) return da.getTime() === db.getTime();
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return stringify(a) === stringify(b);
}

// ---- interpreter -----------------------------------------------------------

/** Methods callable on a value: `due.isEmpty()`, `list(x).filter(...)`, … */
function callMethod(target: BaseValue, name: string, args: Node[], ctx: BaseEvalContext, evalNode: (n: Node, scope?: Scope) => BaseValue, scope?: Scope): BaseValue {
  const arg = (i: number): BaseValue => (args[i] === undefined ? null : evalNode(args[i], scope));

  switch (name) {
    case 'isEmpty': return isEmptyValue(target);
    case 'isNotEmpty': return !isEmptyValue(target);
    case 'toString': return stringify(target);
    case 'length': return Array.isArray(target) ? target.length : stringify(target).length;
    case 'lower': case 'toLowerCase': return stringify(target).toLowerCase();
    case 'upper': case 'toUpperCase': return stringify(target).toUpperCase();
    case 'trim': return stringify(target).trim();
    case 'startsWith': return stringify(target).startsWith(stringify(arg(0)));
    case 'endsWith': return stringify(target).endsWith(stringify(arg(0)));
    case 'split': return stringify(target).split(stringify(arg(0)));
    case 'replace': return stringify(target).split(stringify(arg(0))).join(stringify(arg(1)));
    case 'slice': return stringify(target).slice(Number(toNumber(arg(0))) || 0, args[1] ? Number(toNumber(arg(1))) : undefined);
    case 'contains': case 'includes': {
      const needle = arg(0);
      if (Array.isArray(target)) return target.some((item) => looseEquals(item, needle));
      return stringify(target).toLowerCase().includes(stringify(needle).toLowerCase());
    }
    case 'containsAll': return toList(arg(0)).every((needle) => toList(target).some((item) => looseEquals(item, needle)));
    case 'containsAny': return toList(arg(0)).some((needle) => toList(target).some((item) => looseEquals(item, needle)));
    case 'floor': return Math.floor(toNumber(target));
    case 'ceil': return Math.ceil(toNumber(target));
    case 'round': {
      const digits = args.length ? Number(toNumber(arg(0))) || 0 : 0;
      const factor = 10 ** digits;
      return Math.round(toNumber(target) * factor) / factor;
    }
    case 'abs': return Math.abs(toNumber(target));
    case 'format': {
      const date = parseDateValue(target);
      return date ? formatDate(date, args.length ? stringify(arg(0)) : 'YYYY-MM-DD') : '';
    }
    case 'date': return parseDateValue(target);
    case 'unique': {
      const out: BaseValue[] = [];
      for (const item of toList(target)) if (!out.some((seen) => looseEquals(seen, item))) out.push(item);
      return out;
    }
    case 'sort': return [...toList(target)].sort(compare);
    case 'reverse': return [...toList(target)].reverse();
    case 'join': return toList(target).map(stringify).join(args.length ? stringify(arg(0)) : ', ');
    case 'first': return toList(target)[0] ?? null;
    case 'last': { const list = toList(target); return list[list.length - 1] ?? null; }
    case 'filter': {
      // `value` is the implicit per-item binding in Bases lambdas.
      return toList(target).filter((item, index) => truthy(evalNode(args[0], { value: item, index })));
    }
    case 'map': return toList(target).map((item, index) => evalNode(args[0], { value: item, index }));
    case 'reduce': {
      let acc: BaseValue = args[1] ? arg(1) : 0;
      for (const [index, item] of toList(target).entries()) {
        acc = evalNode(args[0], { value: item, index, acc });
      }
      return acc;
    }
    case 'hasTag': {
      // `file.hasTag("task")` gates most shipped .base views, so the target may
      // be the file object or a bare tag list. Tags match with or without '#',
      // and a parent tag matches its nested children (Obsidian semantics).
      const owned = objectField(target, 'tags') ?? target;
      const have = toList(owned).map((tag) => normalizeTag(stringify(tag)));
      const wanted = args.flatMap((_, i) => toList(arg(i))).map((tag) => normalizeTag(stringify(tag)));
      if (!wanted.length) return have.length > 0;
      return wanted.some((tag) => have.some((own) => own === tag || own.startsWith(`${tag}/`)));
    }
    case 'hasProperty': {
      const props = objectField(target, 'properties') ?? target;
      const key = stringify(arg(0));
      if (!props || typeof props !== 'object' || Array.isArray(props) || props instanceof Date) return false;
      const value = (props as Record<string, BaseValue>)[key];
      return value !== undefined && !isEmptyValue(value);
    }
    case 'hasLink': {
      const links = objectField(target, 'links') ?? target;
      const needle = linkTarget(arg(0));
      if (!needle) return false;
      return toList(links).some((link) => linkTarget(link) === needle);
    }
    case 'asLink': return linkTarget(target);
    case 'isType': {
      const wanted = stringify(arg(0)).toLowerCase();
      const actual = target === null || target === undefined
        ? 'null'
        : Array.isArray(target) ? 'array'
          : target instanceof Date ? 'date'
            : typeof target;
      return actual === wanted;
    }
    default: {
      // Unknown method on an object: fall back to property access.
      if (target && typeof target === 'object' && !Array.isArray(target) && name in target) {
        return (target as Record<string, BaseValue>)[name];
      }
      return null;
    }
  }
}

interface Scope { value?: BaseValue; index?: number; acc?: BaseValue; }

export function evaluate(src: string, ctx: BaseEvalContext): BaseValue {
  const ast = parseExpression(src);
  if (!ast) return null;

  const evalNode = (node: Node, scope?: Scope): BaseValue => {
    switch (node.t) {
      case 'lit': return node.v;
      case 'ident': {
        if (scope) {
          if (node.name === 'value' && 'value' in scope) return scope.value ?? null;
          if (node.name === 'index' && scope.index !== undefined) return scope.index;
          if (node.name === 'acc' && 'acc' in scope) return scope.acc ?? null;
        }
        return ctx.resolve(node.name);
      }
      case 'member': {
        // Dotted identifier chains (note.due, file.name) resolve as a whole path.
        const path = flattenPath(node);
        if (path) {
          if (scope && path.startsWith('value.')) {
            return readPath(scope.value ?? null, path.slice('value.'.length));
          }
          const resolved = ctx.resolve(path);
          if (resolved !== undefined) return resolved;
        }
        const obj = evalNode(node.obj, scope);
        return readPath(obj, node.name);
      }
      case 'index': {
        const obj = evalNode(node.obj, scope);
        const idx = evalNode(node.idx, scope);
        if (Array.isArray(obj)) return obj[Number(toNumber(idx))] ?? null;
        return readPath(obj, stringify(idx));
      }
      case 'unary': {
        const arg = evalNode(node.arg, scope);
        return node.op === '!' ? !truthy(arg) : -toNumber(arg);
      }
      case 'cond': return truthy(evalNode(node.c, scope)) ? evalNode(node.a, scope) : evalNode(node.b, scope);
      case 'bin': {
        const { op } = node;
        if (op === '&&') return truthy(evalNode(node.l, scope)) ? truthy(evalNode(node.r, scope)) : false;
        if (op === '||') return truthy(evalNode(node.l, scope)) ? true : truthy(evalNode(node.r, scope));
        if (op === '??') { const l = evalNode(node.l, scope); return isEmptyValue(l) ? evalNode(node.r, scope) : l; }
        const l = evalNode(node.l, scope);
        const r = evalNode(node.r, scope);
        switch (op) {
          case '==': case '===': return looseEquals(l, r);
          case '!=': case '!==': return !looseEquals(l, r);
          case '<': return compare(l, r) < 0;
          case '>': return compare(l, r) > 0;
          case '<=': return compare(l, r) <= 0;
          case '>=': return compare(l, r) >= 0;
          case '+': {
            // Date + "7 days" is date arithmetic; string operands concatenate.
            const date = dateOperand(l);
            if (date && typeof r === 'string' && !parseDateValue(r)) return shiftDate(date, r);
            if (typeof l === 'string' || typeof r === 'string') {
              const nl = toNumber(l);
              const nr = toNumber(r);
              if (typeof l === 'number' || typeof r === 'number' || Number.isNaN(nl) || Number.isNaN(nr)) {
                return stringify(l) + stringify(r);
              }
              return nl + nr;
            }
            return toNumber(l) + toNumber(r);
          }
          case '-': {
            const date = dateOperand(l);
            if (date && typeof r === 'string' && !parseDateValue(r)) return shiftDate(date, `-${r}`);
            return toNumber(l) - toNumber(r);
          }
          case '*': return toNumber(l) * toNumber(r);
          case '/': { const d = toNumber(r); return d === 0 ? null : toNumber(l) / d; }
          case '%': { const d = toNumber(r); return d === 0 ? null : toNumber(l) % d; }
          default: return null;
        }
      }
      case 'call': {
        const { callee, args } = node;
        if (callee.t === 'member') {
          const path = flattenPath(callee);
          // A dotted path that resolves to a value means this is a method call on
          // it (`due.isEmpty()`); otherwise treat the base as an expression.
          if (path) {
            const resolved = ctx.resolve(path);
            if (resolved !== undefined && resolved !== null) {
              return callMethod(resolved, callee.name, args, ctx, evalNode, scope);
            }
            const parentPath = path.slice(0, path.length - callee.name.length - 1);
            const parent = parentPath ? ctx.resolve(parentPath) : undefined;
            if (parent !== undefined) return callMethod(parent ?? null, callee.name, args, ctx, evalNode, scope);
          }
          const target = evalNode(callee.obj, scope);
          return callMethod(target, callee.name, args, ctx, evalNode, scope);
        }
        if (callee.t !== 'ident') return null;
        const arg = (i: number): BaseValue => (args[i] === undefined ? null : evalNode(args[i], scope));
        switch (callee.name) {
          case 'if': return truthy(arg(0)) ? arg(1) : (args[2] ? arg(2) : null);
          // `[a, b]` literal: never coerces, so [[1,2]] stays nested.
          case '@array': return args.map((_, i) => arg(i));
          case 'list': {
            // list(x) coerces a single value to a list (an array stays as-is);
            // list(a, b, …) builds one from the arguments.
            if (args.length === 1) return toList(arg(0));
            return args.map((_, i) => arg(i));
          }
          case 'number': { const n = toNumber(arg(0)); return Number.isNaN(n) ? null : n; }
          case 'string': return stringify(arg(0));
          case 'date': return parseDateValue(arg(0));
          case 'now': return new Date(ctx.now);
          case 'today': { const d = new Date(ctx.now); d.setHours(0, 0, 0, 0); return d; }
          case 'min': { const nums = args.map((_, i) => toNumber(arg(i))).filter((n) => !Number.isNaN(n)); return nums.length ? Math.min(...nums) : null; }
          case 'max': { const nums = args.map((_, i) => toNumber(arg(i))).filter((n) => !Number.isNaN(n)); return nums.length ? Math.max(...nums) : null; }
          case 'round': return Math.round(toNumber(arg(0)));
          case 'floor': return Math.floor(toNumber(arg(0)));
          case 'ceil': return Math.ceil(toNumber(arg(0)));
          case 'abs': return Math.abs(toNumber(arg(0)));
          case 'duration': return stringify(arg(0));
          case 'file': {
            // Resolve another note so `file(x).properties.status` works. Without
            // a lookup the result is null, which keeps filters false rather than
            // throwing.
            const target = linkTarget(arg(0));
            if (!target || !ctx.lookupFile) return null;
            return ctx.lookupFile(target);
          }
          case 'link': return stringify(arg(0));
          case 'empty': return isEmptyValue(arg(0));
          default: {
            const resolved = ctx.resolve(callee.name);
            return resolved === undefined ? null : resolved;
          }
        }
      }
      default: return null;
    }
  };

  try {
    return evalNode(ast);
  } catch {
    return null;
  }
}

/** Turn a member chain back into `a.b.c`, or null if it is computed. */
function flattenPath(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node = node;
  while (cur.t === 'member') { parts.unshift(cur.name); cur = cur.obj; }
  if (cur.t !== 'ident') return null;
  parts.unshift(cur.name);
  return parts.join('.');
}

function readPath(value: BaseValue, path: string): BaseValue {
  let cur: BaseValue = value;
  for (const part of path.split('.')) {
    if (cur == null) return null;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isNaN(idx) ? null : cur[idx] ?? null;
      continue;
    }
    if (typeof cur === 'object' && !(cur instanceof Date)) {
      cur = (cur as Record<string, BaseValue>)[part] ?? null;
      continue;
    }
    return null;
  }
  return cur;
}

/** Evaluate a filter tree (`and` / `or` / `not` / expression string). */
export function evaluateFilter(filter: unknown, ctx: BaseEvalContext): boolean {
  if (filter == null) return true;
  if (typeof filter === 'string') return filter.trim() ? truthy(evaluate(filter, ctx)) : true;
  if (Array.isArray(filter)) return filter.every((item) => evaluateFilter(item, ctx));
  if (typeof filter !== 'object') return true;
  const record = filter as Record<string, unknown>;
  if ('and' in record) {
    const list = Array.isArray(record.and) ? record.and : [record.and];
    if (!list.every((item) => evaluateFilter(item, ctx))) return false;
  }
  if ('or' in record) {
    const list = Array.isArray(record.or) ? record.or : [record.or];
    if (list.length && !list.some((item) => evaluateFilter(item, ctx))) return false;
  }
  if ('not' in record) {
    const list = Array.isArray(record.not) ? record.not : [record.not];
    if (list.some((item) => evaluateFilter(item, ctx))) return false;
  }
  return true;
}

export const __testing = { tokenize, parseExpression, compare, shiftDate };
