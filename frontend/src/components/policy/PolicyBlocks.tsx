import * as React from "react";

import type { PolicyBlock } from "@/types/policy";

/**
 * Renders parsed policy blocks. The ONE renderer — the public page and the admin preview both use
 * it, so what an approver sees is what a reader gets.
 *
 * Every value reaches the DOM as a React text child, which React escapes. There is no
 * `dangerouslySetInnerHTML` here and there must never be one: a policy body is author-supplied
 * content, and the entire content model exists so it can be displayed without ever becoming markup.
 * A body containing `<script>` renders those characters on screen.
 *
 * `whitespace-pre-wrap` on paragraphs keeps the author's line breaks — addresses and stacked
 * clauses depend on them — while still wrapping long lines to the column.
 */
export function PolicyBlocks({ blocks }: { blocks: PolicyBlock[] }) {
  return (
    <div className="space-y-5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <h2
                key={i}
                className="pt-3 text-lg font-extrabold tracking-tight text-[var(--ink)] first:pt-0"
              >
                {block.text}
              </h2>
            );
          case "list":
            return (
              <ul key={i} className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-[var(--muted)]">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            );
          case "paragraph":
          default:
            return (
              <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted)]">
                {block.text}
              </p>
            );
        }
      })}
    </div>
  );
}
