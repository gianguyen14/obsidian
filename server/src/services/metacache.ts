import path from 'node:path';
import { parseDocument } from 'yaml';
import { listMarkdownFiles, readFileText } from './vault.js';

/**
 * Obsidian-compatible metadata cache.
 *
 * The plugin API hands plugins a synchronous `metadataCache.getFileCache(file)`
 * that must answer for *every* file in the vault, with real `position` objects.
 * `links.ts` already keeps a link graph, but it stores only normalized targets
 * and no positions, so it cannot back that contract. This module parses the
 * richer per-file shape once and keeps it in memory for the web client to mirror.
 */

export interface Loc {
  line: number;
  col: number;
  offset: number;
}

export interface Pos {
  start: Loc;
  end: Loc;
}

export interface LinkCache {
  link: string;
  original: string;
  displayText: string;
  position: Pos;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}

export interface TagCache {
  tag: string;
  position: Pos;
}

export interface ListItemCache {
  position: Pos;
  /** Line of the parent item; negative means top-level (Obsidian convention). */
  parent: number;
  /** ' ' or 'x' for checkboxes, absent for plain bullets. */
  task?: string;
  id?: string;
}

export interface SectionCache {
  type: 'yaml' | 'heading' | 'code' | 'list' | 'paragraph' | 'blockquote' | 'table' | 'thematicBreak';
  position: Pos;
}

export interface FileCache {
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Pos;
  frontmatterLinks?: LinkCache[];
  headings: HeadingCache[];
  tags: TagCache[];
  links: LinkCache[];
  embeds: LinkCache[];
  listItems: ListItemCache[];
  sections: SectionCache[];
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TAG_RE = /(?<![\w&])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[([ xX/>\-?!*"lbin,pcSk])\][ \t]+)?/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Build a line-start offset table so positions can be reported in O(1). */
function lineStarts(raw: string): number[] {
  const starts = [0];
  for (let i = 0; i < raw.length; i += 1) if (raw[i] === '\n') starts.push(i + 1);
  return starts;
}

function locAt(offset: number, starts: number[]): Loc {
  // binary search for the line containing `offset`
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo], offset };
}

function posAt(start: number, end: number, starts: number[]): Pos {
  return { start: locAt(start, starts), end: locAt(end, starts) };
}

function splitTarget(raw: string): { link: string; displayText: string } {
  const [before, alias] = raw.split('|');
  const link = before.trim();
  return { link, displayText: (alias ?? link.split('#').pop() ?? link).trim() || link };
}

/** Collect wikilink-style targets found inside frontmatter scalar values. */
function frontmatterLinks(fmRaw: string, fmOffset: number, starts: number[]): LinkCache[] {
  const out: LinkCache[] = [];
  for (const m of fmRaw.matchAll(WIKILINK_RE)) {
    const { link, displayText } = splitTarget(m[2]);
    if (!link) continue;
    const at = fmOffset + (m.index ?? 0);
    out.push({ link, original: m[0], displayText, position: posAt(at, at + m[0].length, starts) });
  }
  return out;
}

/**
 * Parse one markdown document into the Obsidian cache shape. Code fences and
 * inline code are skipped for tags/links so `#hashtag` inside a snippet does not
 * become a real tag (a long-standing source of false positives in the old shim).
 */
export function parseFileCache(rel: string, raw: string): FileCache {
  const starts = lineStarts(raw);
  const cache: FileCache = {
    headings: [],
    tags: [],
    links: [],
    embeds: [],
    listItems: [],
    sections: [],
  };

  let bodyOffset = 0;
  const fm = FRONTMATTER_RE.exec(raw);
  if (fm) {
    bodyOffset = fm[0].length;
    cache.frontmatterPosition = posAt(0, fm[0].length, starts);
    try {
      const doc = parseDocument(fm[1], { uniqueKeys: false });
      const parsed = doc.toJS({ maxAliasCount: 50 });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cache.frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed frontmatter: leave undefined, still index the body */
    }
    const links = frontmatterLinks(fm[1], raw.indexOf(fm[1]), starts);
    if (links.length) cache.frontmatterLinks = links;
  }

  // Frontmatter tags participate in the tag cache; Obsidian reports them without
  // a body position, so anchor them at the frontmatter block.
  const fmTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
  const fmTagPos = cache.frontmatterPosition ?? posAt(0, 0, starts);
  const pushFmTag = (value: unknown) => {
    const text = String(value).trim();
    if (!text) return;
    cache.tags.push({ tag: text.startsWith('#') ? text : `#${text}`, position: fmTagPos });
  };
  if (Array.isArray(fmTags)) fmTags.forEach(pushFmTag);
  else if (typeof fmTags === 'string') fmTags.split(/[,\s]+/).forEach(pushFmTag);

  let inFence = false;
  let fenceMarker = '';
  let sectionStart = -1;
  let sectionType: SectionCache['type'] | null = null;
  const listStack: { indent: number; line: number }[] = [];

  const closeSection = (endOffset: number) => {
    if (sectionStart < 0 || !sectionType) return;
    cache.sections.push({ type: sectionType, position: posAt(sectionStart, endOffset, starts) });
    sectionStart = -1;
    sectionType = null;
  };

  if (fm) cache.sections.push({ type: 'yaml', position: cache.frontmatterPosition! });

  const firstBodyLine = fm ? locAt(bodyOffset, starts).line : 0;

  for (let line = firstBodyLine; line < starts.length; line += 1) {
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : raw.length;
    const text = raw.slice(start, end).replace(/\r$/, '');
    const trimmed = text.trim();

    const fence = FENCE_RE.exec(text);
    if (fence) {
      if (!inFence) {
        closeSection(start - 1);
        inFence = true;
        fenceMarker = fence[1][0];
        sectionStart = start;
        sectionType = 'code';
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        closeSection(end);
      }
      continue;
    }
    if (inFence) continue;

    if (!trimmed) {
      closeSection(start > 0 ? start - 1 : 0);
      listStack.length = 0;
      continue;
    }

    const heading = HEADING_RE.exec(text);
    if (heading) {
      closeSection(start > 0 ? start - 1 : 0);
      cache.headings.push({
        heading: heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim(),
        level: heading[1].length,
        position: posAt(start, end, starts),
      });
      cache.sections.push({ type: 'heading', position: posAt(start, end, starts) });
      listStack.length = 0;
    } else {
      const list = LIST_RE.exec(text);
      if (list) {
        const indent = list[1].replace(/\t/g, '    ').length;
        while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
        const parent = listStack.length ? listStack[listStack.length - 1].line : -1 - line;
        const item: ListItemCache = { position: posAt(start, end, starts), parent };
        if (list[2] !== undefined) item.task = list[2];
        cache.listItems.push(item);
        listStack.push({ indent, line });
        if (sectionType !== 'list') {
          closeSection(start > 0 ? start - 1 : 0);
          sectionStart = start;
          sectionType = 'list';
        }
      } else if (sectionType === null) {
        sectionStart = start;
        sectionType = trimmed.startsWith('>')
          ? 'blockquote'
          : trimmed.startsWith('|')
            ? 'table'
            : /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(trimmed)
              ? 'thematicBreak'
              : 'paragraph';
      }
    }

    // Blank out inline code so its contents never yield tags or links.
    const scan = text.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));

    for (const m of scan.matchAll(WIKILINK_RE)) {
      const { link, displayText } = splitTarget(m[2]);
      if (!link) continue;
      const at = start + (m.index ?? 0);
      const entry: LinkCache = {
        link,
        original: m[0],
        displayText,
        position: posAt(at, at + m[0].length, starts),
      };
      (m[1] === '!' ? cache.embeds : cache.links).push(entry);
    }

    for (const m of scan.matchAll(MDLINK_RE)) {
      const target = m[3].trim();
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const at = start + (m.index ?? 0);
      const entry: LinkCache = {
        link: decodeURIComponent(target),
        original: m[0],
        displayText: m[2] || target,
        position: posAt(at, at + m[0].length, starts),
      };
      (m[1] === '!' ? cache.embeds : cache.links).push(entry);
    }

    for (const m of scan.matchAll(TAG_RE)) {
      const at = start + (m.index ?? 0);
      cache.tags.push({ tag: `#${m[1]}`, position: posAt(at, at + m[0].length, starts) });
    }
  }

  closeSection(raw.length);
  void rel;
  return cache;
}

// ---- in-memory store -------------------------------------------------------

const caches = new Map<string, FileCache>();
/** basename / path key (lowercased, extensionless) -> vault-relative path */
let keyToPath = new Map<string, string>();

const stripExt = (rel: string) => rel.replace(/\.(md|markdown)$/i, '');
const linkTargetKey = (target: string) => stripExt(target.split('#')[0].split('|')[0].trim()).toLowerCase();

function rebuildKeys(): void {
  const next = new Map<string, string>();
  for (const rel of caches.keys()) {
    next.set(stripExt(rel).toLowerCase(), rel);
    const base = stripExt(path.basename(rel)).toLowerCase();
    // full paths win over bare basenames on collision
    if (!next.has(base)) next.set(base, rel);
  }
  keyToPath = next;
}

export async function buildMetaCache(): Promise<void> {
  caches.clear();
  for (const rel of await listMarkdownFiles()) {
    try {
      caches.set(rel, parseFileCache(rel, await readFileText(rel)));
    } catch {
      /* unreadable file: skip, it simply has no cache */
    }
  }
  rebuildKeys();
}

export async function upsertMetaCache(rel: string): Promise<void> {
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return;
  try {
    caches.set(rel, parseFileCache(rel, await readFileText(rel)));
    rebuildKeys();
  } catch {
    /* file vanished between the event and the read */
  }
}

export function removeMetaCache(rel: string): void {
  if (caches.delete(rel)) rebuildKeys();
}

export function getMetaCache(rel: string): FileCache | null {
  return caches.get(rel) ?? null;
}

export function resolveMetaLink(target: string): string | undefined {
  return keyToPath.get(linkTargetKey(target));
}

/**
 * Obsidian's resolvedLinks/unresolvedLinks: source path -> target -> count.
 * Resolved targets are keyed by vault-relative path, unresolved ones by the raw
 * link text, matching the desktop app so graph/backlink plugins behave the same.
 */
export function linkMaps(): {
  resolvedLinks: Record<string, Record<string, number>>;
  unresolvedLinks: Record<string, Record<string, number>>;
} {
  const resolvedLinks: Record<string, Record<string, number>> = {};
  const unresolvedLinks: Record<string, Record<string, number>> = {};

  for (const [rel, cache] of caches) {
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    const all = [...cache.links, ...cache.embeds, ...(cache.frontmatterLinks ?? [])];
    for (const link of all) {
      const dest = resolveMetaLink(link.link);
      if (dest) resolved[dest] = (resolved[dest] ?? 0) + 1;
      else {
        const key = link.link.split('#')[0].trim();
        if (key) unresolved[key] = (unresolved[key] ?? 0) + 1;
      }
    }
    resolvedLinks[rel] = resolved;
    unresolvedLinks[rel] = unresolved;
  }
  return { resolvedLinks, unresolvedLinks };
}

export function allMetaCaches(): Record<string, FileCache> {
  return Object.fromEntries(caches);
}
