/**
 * The policy content model: authored plain text → typed blocks.
 *
 * ## Why not Markdown, rich text, or HTML
 *
 * A legal notice needs headings and lists and nothing else. The three options that would give it
 * those all cost more than they are worth here:
 *
 *   - HTML would be the FIRST injection surface in this application. Nothing in the frontend uses
 *     `dangerouslySetInnerHTML`, and admitting authored HTML means admitting a sanitiser and the
 *     permanent job of keeping it correct.
 *   - A Markdown library is a dependency whose renderers almost all pass raw HTML through by
 *     default, which re-opens the same question one layer down.
 *   - A rich-text editor is a large dependency that produces a document tree still needing safe
 *     rendering at the end of it.
 *
 * So: three rules, parsed here, rendered as React text nodes. The output carries TEXT, never markup,
 * so `<script>alert(1)</script>` in the body is displayed — it cannot execute, because at no point
 * does anything turn it into HTML.
 *
 * ## The rules, in full
 *
 *   "# " at the start of a line   → heading
 *   "- " at the start of a line   → list item (consecutive items form one list)
 *   a blank line                  → block separator
 *   anything else                 → literal text, joined into a paragraph
 *
 * The trailing SPACE in the two prefixes is deliberate: "#hashtag" and "-5 degrees" are ordinary
 * prose and stay prose. There is no inline syntax at all — no bold, no links, no escapes — because
 * every one of those is a rule an author has to know and a case this parser could get wrong.
 *
 * Parsing happens on the SERVER, once. The public page and the admin preview both render the blocks
 * this returns, so the two can never disagree about what a draft will look like.
 */

export type PolicyBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

const HEADING_PREFIX = "# ";
const LIST_PREFIX = "- ";

/**
 * Parse an authored body into blocks. Total: every input produces a valid block list, and an empty
 * or whitespace-only body produces an empty one (which the caller reads as "nothing to show").
 *
 * Paragraph lines are joined with newlines rather than reflowed into one line — a policy carries
 * addresses and short stacked clauses where the author's line breaks are meaningful. The renderer
 * preserves them.
 */
export function parsePolicyBody(body: string): PolicyBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: PolicyBlock[] = [];

  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ type: "list", items: list });
    list = [];
  };
  // A block ends whenever a different KIND of line arrives, so the two flushes always run together
  // and in the same order — a list directly after a paragraph must not swallow it, or vice versa.
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    // Prefixes are matched against the RAW line, before any trimming. The trailing space in "# " and
    // "- " is the marker: trimming first turns "# " into "#", which no longer matches its own rule,
    // and a lone marker would silently become a paragraph containing a stray hash.
    if (raw.trim() === "") {
      flushAll();
      continue;
    }

    if (raw.startsWith(HEADING_PREFIX)) {
      flushAll();
      const text = raw.slice(HEADING_PREFIX.length).trim();
      // "# " with nothing after it is not a heading — it is an empty line the author typed oddly,
      // and emitting a blank heading would put a gap in the document with no way to see why.
      if (text) blocks.push({ type: "heading", text });
      continue;
    }

    if (raw.startsWith(LIST_PREFIX)) {
      // A list interrupts a paragraph but continues a list.
      flushParagraph();
      const item = raw.slice(LIST_PREFIX.length).trim();
      if (item) list.push(item);
      continue;
    }

    // Ordinary prose. It ends any open list — a plain line after bullets is a new paragraph, not a
    // continuation of the last bullet. Trailing whitespace is dropped; leading is the author's.
    flushList();
    paragraph.push(raw.trimEnd());
  }

  flushAll();
  return blocks;
}
