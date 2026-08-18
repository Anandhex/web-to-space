/**
 * links/__tests__/sample-anchors.ts — draw the gold-set sample.
 *
 *   npx tsx src/links/__tests__/sample-anchors.ts [n-per-doc]
 *
 * Prints, for every sampled anchor, the raw HTML around it — the enclosing
 * element chain, the anchor tag, and the sentence it sits in. Annotation is
 * done by reading THAT, not by reading what the classifier decided, so the
 * gold labels are a judgement about the document rather than a transcription
 * of the thing being scored.
 *
 * The sample is deterministic (a fixed-seed stride over the document's anchors
 * in DOM order), so re-running it re-draws the same anchors and an annotation
 * file stays valid.
 */
import "../../eval/dom-bootstrap";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/eval/link-corpus";
const PER_DOC = Number(process.argv[2] ?? 36);

/** The five documents the gold set is annotated over. */
export const GOLD_DOCS = [
  "en.wikipedia.org-wiki-hypertext.html",
  "en.wikipedia.org-wiki-information-architecture.html",
  "developer.mozilla.org-en-us-docs-web-api-webxr-device-api.html",
  "html.spec.whatwg.org-multipage-links.html.html",
  "www.nngroup.com-articles-ten-usability-heuristics.html",
];

/** Every `n`th anchor, so the sample spans the whole document, not its head. */
export function stride<T>(items: T[], want: number): T[] {
  if (items.length <= want) return items;
  const step = items.length / want;
  const out: T[] = [];
  for (let i = 0; i < want; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function chainOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el.parentElement;
  let depth = 0;
  while (cur && depth < 8 && cur.tagName.toLowerCase() !== "html") {
    const tag = cur.tagName.toLowerCase();
    const role = cur.getAttribute("role");
    const cls = (cur.getAttribute("class") ?? "").split(/\s+/).slice(0, 2).join(".");
    const id = cur.getAttribute("id");
    parts.unshift(
      tag +
        (role ? `[role=${role}]` : "") +
        (id ? `#${id}` : "") +
        (cls ? `.${cls}` : ""),
    );
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function sentenceOf(el: Element): string {
  const block = el.closest("p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, figcaption");
  const text = (block ?? el).textContent ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function main(): void {
  if (!existsSync(DIR)) {
    console.error(`No corpus at ${DIR}. Run: npm run census:fetch`);
    process.exit(1);
  }
  const present = new Set(readdirSync(DIR));
  for (const doc of GOLD_DOCS) {
    if (!present.has(doc)) {
      console.error(`missing ${doc} — run npm run census:fetch`);
      continue;
    }
    const html = readFileSync(join(DIR, doc), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const anchors = Array.from(parsed.querySelectorAll("a[href]"));
    console.log(`\n${"=".repeat(78)}\n${doc}  (${anchors.length} anchors)\n${"=".repeat(78)}`);
    for (const a of stride(anchors, PER_DOC)) {
      const href = a.getAttribute("href") ?? "";
      const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      console.log(`\n--- href: ${href}`);
      console.log(`    text: ${JSON.stringify(text.slice(0, 80))}`);
      const aria = a.getAttribute("aria-label");
      const title = a.getAttribute("title");
      if (aria) console.log(`    aria-label: ${JSON.stringify(aria)}`);
      if (title) console.log(`    title: ${JSON.stringify(title)}`);
      console.log(`    chain: ${chainOf(a)}`);
      console.log(`    in: ${JSON.stringify(sentenceOf(a))}`);
    }
  }
}

main();
