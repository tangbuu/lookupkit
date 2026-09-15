import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Turns fully-rendered page HTML into line-oriented plain text.
 *
 * Two tiers, and BOTH are needed:
 *
 *  1. Mozilla Readability (the Firefox Reader Mode algorithm). It beats a
 *     hand-written selector heuristic on nearly every article and data page,
 *     including pages that lay their numbers out in `<div>` grids rather than
 *     semantic tags.
 *  2. A `p / table / h1-h6` heuristic fallback. Readability scores pages for
 *     "article-ness" and returns NOTHING for legitimate listing and index
 *     pages that have no single body of prose — a news aggregator's topic
 *     page, for instance. Dropping tier 2 loses those pages entirely.
 *
 * Line boundaries are preserved on purpose: the condenser ranks per line, so
 * flattening the document into one blob would destroy its scoring unit. Table
 * rows are emitted one row per line for the same reason — split a row across
 * lines and the label ("SJC") parts company with its number ("146,000"), and
 * the number-only line then matches no query term and is dropped.
 */

const BLOCK_TAGS =
  /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H1|H2|H3|H4|H5|H6|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TR|UL)$/;

function tableRows(table: Element, push: (line: string) => void): void {
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(row.querySelectorAll('td, th'))
      .map((c) => (c.textContent ?? '').trim().replace(/\s+/g, ' '))
      .filter((c) => c.length > 0);
    if (cells.length > 0) push(cells.join(' '));
  }
}

function blockText(root: Element): string {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.tagName === 'TABLE') {
      tableRows(el, (line) => out.push(`\n${line}\n`));
      return;
    }
    const isBlock = BLOCK_TAGS.test(el.tagName);
    if (isBlock) out.push('\n');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) out.push('\n');
  };
  walk(root);
  return out
    .join('')
    .replace(/[ \t\r\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

/** Tier 2: semantic-tag heuristic over the whole body. */
function simpleExtract(doc: Document): string {
  if (!doc.body) return '';
  const clone = doc.body.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll('script,style,nav,footer,header,aside,noscript'))) {
    el.remove();
  }
  const parts: string[] = [];
  for (const el of Array.from(clone.querySelectorAll('p, table, h1, h2, h3, h4, h5, h6'))) {
    if (el.tagName === 'TABLE') {
      tableRows(el, (line) => parts.push(line));
      continue;
    }
    const t = (el.textContent ?? '').trim().replace(/[ \t]+/g, ' ');
    if (t.length > 0) parts.push(t);
  }
  return parts.join('\n');
}

/** Tier 1: Mozilla Readability. Returns '' when it declines to parse. */
function readabilityExtract(doc: Document): string {
  try {
    // Readability's own README: "The parse() method works by modifying the
    // DOM... You can avoid this by passing the clone of the document object".
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability(clone, {
      // Default 500 makes parse() return null on exactly the pages that need
      // help most: data pages (prices, weather) carry many numbers and little
      // prose.
      charThreshold: 200,
      serializer: (el) => el,
    }).parse();
    const content = article?.content as unknown as Element | undefined;
    if (!content || content.nodeType !== 1) return '';
    let text = blockText(content);
    const title = (article?.title ?? '').trim();
    if (title.length > 0 && !text.startsWith(title)) text = `${title}\n${text}`;
    return text;
  } catch {
    return '';
  }
}

export interface ExtractionResult {
  text: string;
  tier: 'readability' | 'heuristic' | 'empty';
}

/**
 * `html` must be the FULLY RENDERED page source (Playwright's
 * `page.content()`), not the server's original response: jsdom deliberately
 * does not execute scripts here, so anything a page draws client-side has to
 * already be in the markup handed over.
 */
export function extractContent(html: string, url: string): ExtractionResult {
  const virtualConsole = new VirtualConsole(); // swallow page-side CSS/JS noise
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const doc = dom.window.document;
    const readable = readabilityExtract(doc);
    const simple = simpleExtract(doc);

    // Prefer Readability whenever it produced something substantial, but fall
    // back the moment it under-delivers against the plain heuristic.
    if (readable.length >= 200 && readable.length >= simple.length * 0.4) {
      return { text: readable, tier: 'readability' };
    }
    if (readable.length > simple.length) return { text: readable, tier: 'readability' };
    return { text: simple, tier: simple.length > 0 ? 'heuristic' : 'empty' };
  } finally {
    dom.window.close();
  }
}
