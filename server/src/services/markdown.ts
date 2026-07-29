import { parseDocument } from 'yaml';
import path from 'node:path';

export interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  /** Wikilink targets (without alias / heading). */
  links: string[];
  headings: string[];
}

const WIKILINK_RE = /!?\[\[([^\]]+?)\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/gm;

/** Parse a markdown document into structured fields used for search & links. */
export function parseNote(rel: string, raw: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  try {
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
    if (match) {
      const doc = parseDocument(match[1], { uniqueKeys: true });
      if (doc.errors.length) throw doc.errors[0];
      const parsed = doc.toJS({ maxAliasCount: 50 });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
      body = raw.slice(match[0].length);
    }
  } catch {
    /* malformed frontmatter — index raw */
  }

  const links = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) links.add(target);
  }

  const tags = new Set<string>();
  for (const m of body.matchAll(TAG_RE)) tags.add(m[1]);
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) for (const t of fmTags) tags.add(String(t));
  else if (typeof fmTags === 'string') for (const t of fmTags.split(/[,\s]+/)) if (t) tags.add(t);

  const headings: string[] = [];
  for (const m of body.matchAll(HEADING_RE)) headings.push(m[1]);

  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title : undefined;
  const title = fmTitle || path.basename(rel).replace(/\.(md|markdown)$/i, '');

  return { title, frontmatter, body, tags: [...tags], links: [...links], headings };
}

/** Normalize a wikilink target to a comparable key (basename, no ext, lower). */
export function linkKey(target: string): string {
  const base = target.includes('/') ? target : target;
  return base.replace(/\.(md|markdown)$/i, '').toLowerCase();
}
