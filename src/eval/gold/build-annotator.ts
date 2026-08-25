/**
 * eval/gold/build-annotator.ts — build the annotation tool.
 *
 *   npm run gold:annotate                 # one page per file, into eval-out/annotator/
 *   npm run gold:annotate -- --page slug  # just one
 *   npm run gold:annotate -- --blind      # no seeding, for the bias estimate
 *
 * SEEDING. Where a page's provisional file already has a label, the tool starts
 * that unit pre-filled and the annotator confirms or overrides it with the same
 * keystroke. The provisional oracle DECLINES any element with no tag evidence
 * (`labelFor` returns null), so the seeded units are exactly the ones nobody
 * disputes — `<h2>` is a heading — and the units left blank are exactly the ones
 * the parser has to infer, which are the ones the claim rests on. On the ARIA
 * specification that seeds 80%%; on the div-soup fixture it seeds 6%%, which is
 * the right way round.
 *
 * It is still a bias, so the tool records what happened to every label —
 * `blind`, `confirmed`, `changed`, `unreviewed` — and `npm run gold:lint`
 * reports the rates. Run one page `--blind` and compare: the difference between
 * a cold pass and a seeded pass on the same page is the anchoring bias, and a
 * reviewer is entitled to that number.
 *
 * Emits a self-contained HTML file per corpus page. Open it in a browser, label
 * with one keystroke per unit, and export the JSON into
 * `src/eval/gold-annotations/`.
 *
 * The cost model is the reason this exists. The plan budgets ~25 minutes per
 * page per annotator across 60 pages and two annotators — about 30 hours each.
 * At that scale the difference between one keystroke per unit and a dropdown per
 * unit is a week of someone's life, so the tool is a day-one item, not a
 * convenience: keyboard-only, no mouse round-trip, resumable, and it shows the
 * RENDERED page beside the list because a label chosen from markup is a label
 * chosen from the same signal the parser reads.
 */
import "../dom-bootstrap";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectAnnotatableElements } from "./units";
import { GOLD_LABELS } from "./labels";
import { loadManifest, type GoldAnnotation } from "./schema";
import type { GoldLabel } from "./labels";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS = join(HERE, "..", "gold-corpus");
const OUT = resolve(process.cwd(), "eval-out", "annotator");
const GOLD = join(HERE, "..", "gold-annotations");

/** One keystroke per label. Chosen so the common ones sit under the home row. */
const KEYS: Record<string, string> = {
  m: "main-content",
  h: "heading",
  p: "prose",
  l: "list",
  n: "navigation",
  a: "complementary",
  f: "figure",
  v: "media",
  t: "table",
  c: "control",
  k: "code",
  b: "chrome",
  o: "other",
};

/**
 * Neutralise the sequences that end a `<script>` element early, INSIDE AN
 * ALREADY-STRINGIFIED JS LITERAL. `\/` and `\!` are the same characters to the
 * JS lexer, so the runtime string is byte-identical to the input — the escaping
 * exists purely for the HTML tokenizer that runs first.
 *
 * Order matters and is the whole trap: `escapeForScript(JSON.stringify(x))`
 * escapes the LITERAL; `JSON.stringify(escapeForScript(x))` escapes the DATA,
 * which then gets its backslash doubled and leaves a literal `<\/script>` in
 * the value. That is what blanked the page pane — the corpus HTML's own
 * `<script>` in `<head>` never closed, so the tokenizer ate the entire
 * document into head and `<body>` came out empty.
 *
 * `</script` ends the element when followed by whitespace, `/` or `>`, not just
 * by `>`, so every `</` is escaped rather than the exact tag.
 */
function escapeForScript(s: string): string {
  return s.replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

/**
 * Give the framed page a base URL. Without one, `about:srcdoc` inherits the
 * annotator's own base, so every stylesheet, image and relative link resolves
 * against `eval-out/annotator/` and 404s — the annotator would be labelling a
 * wall of unstyled text rather than the rendered page.
 */
function withBase(html: string, url: string): string {
  if (!/^https?:/i.test(url)) return html;
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${url.replace(/"/g, "&quot;")}">`;
  const head = html.match(/<head\b[^>]*>/i);
  return head
    ? html.replace(head[0], `${head[0]}${tag}`)
    : `${tag}${html}`;
}

interface UnitPayload {
  id: string;
  tag: string;
  kind: string;
  depth: number;
  preview: string;
}

function buildPage(
  page: string,
  html: string,
  url: string,
  seed: Record<string, GoldLabel>,
  seededFrom: string | null,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const units = selectAnnotatableElements(doc);
  const payload: UnitPayload[] = units.map((u) => ({
    id: u.evalId,
    tag: u.tag,
    kind: u.kind,
    depth: Math.min(u.depth, 8),
    preview: u.preview,
  }));

  const keyRows = Object.entries(KEYS)
    .map(
      ([k, v]) =>
        `<li><kbd>${k}</kbd><span>${v}</span></li>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Annotate — ${page}</title>
<style>
  :root { --bg:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --line:#e6e5e1; --accent:#2a78d6; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:grid; grid-template-columns: 1fr 460px;
         font:14px/1.5 -apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
         background:var(--bg); color:var(--ink); }
  iframe { width:100%; height:100vh; border:0; border-right:1px solid var(--line); background:#fff; }
  aside { height:100vh; overflow:hidden; display:flex; flex-direction:column; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); }
  h1 { font-size:14px; margin:0 0 4px; }
  .meta { font-size:11.5px; color:var(--ink2); word-break:break-all; }
  .bar { height:4px; background:var(--line); border-radius:2px; margin-top:10px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--accent); width:0; }
  .stat { font-size:11.5px; color:var(--ink2); margin-top:6px; display:flex; gap:12px; }
  .who { display:flex; gap:6px; align-items:center; font-size:11.5px; color:var(--ink2);
         margin-top:8px; }
  .who input { font:12px inherit; padding:3px 6px; border:1px solid var(--line);
               border-radius:4px; width:150px; }
  ol { list-style:none; margin:0; padding:0; overflow-y:auto; flex:1; }
  ol li { padding:7px 16px; border-bottom:1px solid #f2f1ee; cursor:pointer; display:flex; gap:8px; }
  ol li.cur { background:#eaf2fd; box-shadow: inset 3px 0 0 var(--accent); }
  ol li .tag { font:11px ui-monospace,Menlo,monospace; color:var(--ink2); min-width:56px; }
  ol li .txt { flex:1; font-size:12.5px; color:var(--ink); overflow:hidden;
               text-overflow:ellipsis; white-space:nowrap; }
  ol li .lab { font-size:11px; color:#fff; background:var(--accent); border-radius:3px;
               padding:1px 6px; align-self:center; }
  ol li .lab.none { background:#d8d7d2; color:var(--ink2); }
  /* A seeded label the annotator has not looked at is drawn as a proposal —
     outlined, not filled — so a screen of pre-filled labels never reads as a
     screen of finished work. Confirming or changing it fills it in. */
  ol li .lab.p-unreviewed { background:transparent; color:var(--ink2);
                            border:1px dashed #b9b8b3; }
  ol li .lab.p-confirmed { background:var(--accent); }
  ol li .lab.p-changed { background:#8a4fd0; }
  ol li .lab.p-blind { background:#1baf7a; }
  ol li .seg { font:10px ui-monospace,Menlo,monospace; color:#1baf7a; align-self:center; }
  footer { border-top:1px solid var(--line); padding:10px 16px; }
  footer ul { list-style:none; margin:0 0 10px; padding:0; display:grid;
              grid-template-columns:repeat(2,1fr); gap:2px 10px; }
  footer li { font-size:11.5px; color:var(--ink2); display:flex; gap:6px; align-items:center; }
  kbd { font:11px ui-monospace,Menlo,monospace; background:#f0efec; border:1px solid var(--line);
        border-bottom-width:2px; border-radius:3px; padding:0 5px; }
  .row { display:flex; gap:8px; }
  button { font:12px inherit; padding:6px 10px; border:1px solid var(--line); background:#fff;
           border-radius:5px; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .hint { font-size:11px; color:var(--ink2); margin-top:8px; }
</style></head>
<body>
<iframe id="page" sandbox="allow-same-origin"></iframe>
<aside>
  <header>
    <h1>${page}</h1>
    <div class="meta">${url}</div>
    <div class="bar"><i id="prog"></i></div>
    <div class="stat"><span id="count"></span><span id="segcount"></span></div>
    <label class="who">annotator
      <input id="who" type="text" placeholder="your name" autocomplete="off"/>
    </label>
  </header>
  <ol id="list"></ol>
  <footer>
    <ul>${keyRows}</ul>
    <div class="row">
      <button class="primary" id="export">Export JSON</button>
      <button id="import">Load JSON</button>
      <input type="file" id="file" accept="application/json" hidden/>
    </div>
    <div class="hint" id="hint">
      <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>s</kbd> start a new segment here ·
      <kbd>Backspace</kbd> clear · <kbd>Enter</kbd> next unreviewed.
      Work is saved in this browser as you go.
    </div>
  </footer>
</aside>
<script>
const PAGE = ${JSON.stringify(page)};
const URL_ = ${JSON.stringify(url)};
const UNITS = ${escapeForScript(JSON.stringify(payload))};
const KEYS = ${JSON.stringify(KEYS)};
const LABELS = ${JSON.stringify(GOLD_LABELS)};
const HTML = ${escapeForScript(JSON.stringify(withBase(html, url)))};
const SEED = ${escapeForScript(JSON.stringify(seed))};
const SEEDED_FROM = ${JSON.stringify(seededFrom)};
const STORE = "annot:" + PAGE;

// Storage is best-effort. Opened from file:// it works; opened from a sandbox
// or a data: URL it throws SecurityError, and an uncaught throw here would take
// the whole tool down before a single unit was drawn.
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; }
}
function store(v) {
  try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* no persistence */ }
}

const state = load() || {
  annotator: "",
  nodes: Object.assign({}, SEED),
  segments: {},
  readingOrder: [],
  // Units the annotator has actually pressed a label key on. Cursor movement
  // deliberately does NOT count: arrowing down the list would otherwise mark
  // every seeded label confirmed, and a confirmation nobody made is exactly the
  // thing this field exists to prevent. Confirming a seeded label costs one
  // keystroke — the same one that would have produced it from scratch.
  seen: {},
};
if (!state.seen) state.seen = {};

/** blind | confirmed | changed | unreviewed — see GoldAnnotation.provenance. */
function provenanceOf(id) {
  const seeded = Object.prototype.hasOwnProperty.call(SEED, id);
  const label = state.nodes[id];
  if (!seeded) return "blind";
  if (label !== SEED[id]) return "changed";
  return state.seen[id] ? "confirmed" : "unreviewed";
}

/** Record that the annotator acted on this unit, as opposed to scrolling past. */
function touch(id) {
  state.seen[id] = 1;
}

const frame = document.getElementById("page");
frame.srcdoc = HTML;

const list = document.getElementById("list");
let cur = 0;

function render() {
  list.innerHTML = UNITS.map(function (u, i) {
    const lab = state.nodes[u.id];
    const seg = state.segments[u.id];
    const isSegStart = state.readingOrder.indexOf(u.id) >= 0;
    const prov = provenanceOf(u.id);
    return '<li class="' + (i === cur ? "cur" : "") + '" data-i="' + i + '">' +
      '<span class="tag" style="padding-left:' + (u.depth * 5) + 'px">' + u.tag + '</span>' +
      '<span class="txt">' + (u.preview || "<em>(no text)</em>") + '</span>' +
      (isSegStart ? '<span class="seg">§</span>' : (seg ? '<span class="seg">·</span>' : '')) +
      '<span class="lab ' + (lab ? ("p-" + prov) : "none") + '">' + (lab || "—") + '</span>' +
      '</li>';
  }).join("");
  const done = Object.keys(state.nodes).length;
  // Progress is REVIEW progress, not label progress. With seeding, "18 of 18
  // labelled" can mean the annotator has done nothing at all, and a progress bar
  // that reads full before any work is worse than no progress bar.
  let reviewed = 0;
  let unreviewed = 0;
  for (let i = 0; i < UNITS.length; i++) {
    const p = provenanceOf(UNITS[i].id);
    if (p === "unreviewed") unreviewed++;
    else if (state.nodes[UNITS[i].id]) reviewed++;
  }
  document.getElementById("prog").style.width = (reviewed / UNITS.length * 100) + "%";
  document.getElementById("count").textContent =
    reviewed + " / " + UNITS.length + " reviewed" +
    (unreviewed ? "  ·  " + unreviewed + " seeded, untouched" : "");
  document.getElementById("segcount").textContent = state.readingOrder.length + " segments";
  const who = document.getElementById("who");
  if (who !== document.activeElement) who.value = state.annotator;
  const el = list.querySelector("li.cur");
  if (el) el.scrollIntoView({ block: "nearest" });
  highlight();
}

/**
 * Outline the current unit inside the page. The annotator is labelling what the
 * reader sees, so the rendered element is the thing to look at — labelling from
 * the markup would mean labelling from the same signal the parser reads, which
 * is the circularity the gold standard exists to break.
 */
function highlight() {
  const d = frame.contentDocument;
  if (!d) return;
  d.querySelectorAll("[data-annot-hl]").forEach(function (e) {
    e.style.outline = ""; e.removeAttribute("data-annot-hl");
  });
  const u = UNITS[cur];
  if (!u) return;
  const el = d.querySelector('[data-eval-id="' + u.id + '"]');
  if (!el) return;
  el.setAttribute("data-annot-hl", "1");
  el.style.outline = "3px solid #2a78d6";
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function save() { store(state); }

function assign(label) {
  const u = UNITS[cur];
  if (!u) return;
  touch(u.id);
  state.nodes[u.id] = label;
  // Every labelled unit belongs to the segment most recently opened above it.
  const open = state.readingOrder[state.readingOrder.length - 1];
  if (open) state.segments[u.id] = open;
  save();
  cur = Math.min(cur + 1, UNITS.length - 1);
  render();
}

document.addEventListener("keydown", function (e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "arrowdown") { cur = Math.min(cur + 1, UNITS.length - 1); render(); e.preventDefault(); return; }
  if (k === "arrowup") { cur = Math.max(cur - 1, 0); render(); e.preventDefault(); return; }
  if (k === "backspace") { delete state.nodes[UNITS[cur].id]; save(); render(); e.preventDefault(); return; }
  if (k === "enter") {
    // "Next thing needing a decision", which with seeding means the next unit
    // that is either unlabelled or seeded-but-untouched. Skipping to the next
    // UNLABELLED unit would skip the entire page.
    const next = UNITS.findIndex(function (u, i) {
      if (i <= cur) return false;
      const p = provenanceOf(u.id);
      return !state.nodes[u.id] || p === "unreviewed";
    });
    cur = next >= 0 ? next : cur;
    render(); e.preventDefault(); return;
  }
  if (k === "s") {
    const id = UNITS[cur].id;
    if (state.readingOrder.indexOf(id) < 0) state.readingOrder.push(id);
    state.segments[id] = id;
    save(); render(); e.preventDefault(); return;
  }
  if (KEYS[k]) { assign(KEYS[k]); e.preventDefault(); }
});

document.getElementById("who").addEventListener("input", function (e) {
  state.annotator = e.target.value;
  save();
});

// The name field is a text input inside a keyboard-driven tool: without this,
// typing a name labels a dozen units.
document.getElementById("who").addEventListener("keydown", function (e) {
  e.stopPropagation();
});

list.addEventListener("click", function (e) {
  const li = e.target.closest("li");
  if (!li) return;
  cur = Number(li.dataset.i);
  render();
});

document.getElementById("export").addEventListener("click", function () {
  if (!state.annotator) { alert("Enter an annotator name first — the κ table is keyed on it."); return; }
  const missing = UNITS.filter(function (u) { return !state.nodes[u.id]; }).length;
  const untouched = UNITS.filter(function (u) { return provenanceOf(u.id) === "unreviewed"; }).length;
  if (missing > 0 && !confirm(missing + " unit(s) are still unlabelled. Export anyway?")) return;
  if (untouched > 0 && !confirm(
        untouched + " seeded label(s) were never looked at. They will be exported as " +
        "'unreviewed', and the report counts them as the seed's answer rather than yours. " +
        "Export anyway?")) return;
  const provenance = {};
  for (let i = 0; i < UNITS.length; i++) {
    const id = UNITS[i].id;
    if (state.nodes[id]) provenance[id] = provenanceOf(id);
  }
  const out = {
    page: PAGE,
    annotator: state.annotator,
    annotatedAt: new Date().toISOString(),
    nodes: state.nodes,
    segments: state.segments,
    readingOrder: state.readingOrder.slice(),
    provenance: provenance,
    seededFrom: SEEDED_FROM,
  };
  const blob = new Blob([JSON.stringify(out, null, 2) + "\\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = PAGE + "." + state.annotator.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".json";
  a.click();
});

document.getElementById("import").addEventListener("click", function () {
  document.getElementById("file").click();
});
document.getElementById("file").addEventListener("change", function (e) {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then(function (t) {
    const j = JSON.parse(t);
    state.nodes = j.nodes || {};
    state.segments = j.segments || {};
    state.readingOrder = j.readingOrder || [];
    // A "confirmed" label in the file means that unit was looked at; restoring
    // it keeps a resumed session from demoting finished work to "unreviewed".
    state.seen = {};
    const prov = j.provenance || {};
    for (const id in prov) if (prov[id] !== "unreviewed") state.seen[id] = 1;
    if (j.annotator) state.annotator = j.annotator;
    save(); render();
  });
});

frame.addEventListener("load", render);
render();
</script>
</body></html>
`;
}

/**
 * The seed for a page: the provisional oracle's labels, and only those.
 *
 * `labelFor` declines any element with no tag evidence, so this pre-fills the
 * units nobody argues about and leaves blank precisely the units the parser has
 * to infer — the ones every claim in the chapter rests on. Seeding from a human
 * file instead would be worse, not better: it would put one annotator's
 * judgement into the other's tool and destroy the κ the two are for.
 */
function loadSeed(page: string): {
  seed: Record<string, GoldLabel>;
  from: string | null;
} {
  const file = join(GOLD, `${page}.provisional.json`);
  if (!existsSync(file)) return { seed: {}, from: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as GoldAnnotation;
    if (!parsed.provisional) return { seed: {}, from: null };
    return { seed: parsed.nodes ?? {}, from: `${page}.provisional.json` };
  } catch {
    // A malformed seed is not worth failing the build for — annotate unseeded.
    return { seed: {}, from: null };
  }
}

function main(): void {
  if (!existsSync(CORPUS)) {
    console.error(`No corpus at ${CORPUS} — run \`npm run gold:fetch -- --adopt\` first.`);
    process.exit(1);
  }
  const only = process.argv.includes("--page")
    ? process.argv[process.argv.indexOf("--page") + 1]
    : null;
  const blind = process.argv.includes("--blind");
  const manifest = loadManifest(join(CORPUS, "manifest.json"));
  const urls = new Map(manifest.entries.map((e) => [e.page, e.url]));

  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(CORPUS)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => !only || f === `${only}.html`);
  if (files.length === 0) {
    console.error(only ? `No page "${only}" in the corpus.` : "No pages in the corpus.");
    process.exit(1);
  }

  const index: string[] = [];
  for (const f of files) {
    const page = f.replace(/\.html$/, "");
    const html = readFileSync(join(CORPUS, f), "utf8");
    const { seed, from } = blind ? { seed: {}, from: null } : loadSeed(page);
    const out = buildPage(page, html, urls.get(page) ?? "", seed, from);
    writeFileSync(join(OUT, `${page}.html`), out);
    const units = selectAnnotatableElements(
      new DOMParser().parseFromString(html, "text/html"),
    ).length;
    const seeded = Object.keys(seed).length;
    const share = units > 0 ? Math.round((seeded / units) * 100) : 0;
    index.push(
      `<li><a href="${page}.html">${page}</a> <span>${units} units · ` +
        `${seeded ? `${share}% seeded` : "blind"} · ${urls.get(page) ?? ""}</span></li>`,
    );
    console.log(
      `  ${page.padEnd(52)} ${String(units).padStart(6)} units  ` +
        (seeded ? `${String(share).padStart(3)}% seeded, ${units - seeded} blind` : "blind"),
    );
  }

  writeFileSync(
    join(OUT, "index.html"),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Annotation queue</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
max-width:820px;margin:48px auto;padding:0 20px;background:#fcfcfb;color:#0b0b0b}
h1{font-size:22px}ol{padding-left:20px}li{margin:6px 0}span{color:#85847e;font-size:12.5px}
p{color:#52514e;font-size:13.5px}</style></head><body>
<h1>Annotation queue</h1>
<p>One file per page. Label with the keyboard, export the JSON, and drop it into
<code>src/eval/gold-annotations/</code>. Read <code>docs/annotation-guidelines.md</code> first —
the tie-break rules there are what makes two annotators agree.</p>
<p><b>Seeded units start pre-filled</b> and are drawn as a dashed outline until you
confirm or change them — press the same key to confirm, a different key to
override. Only units whose tag is unambiguous are seeded; everything the parser
has to infer is left blank, which is why div-soup pages seed almost nothing.
A seeded label you never look at is exported as <code>unreviewed</code> and counted
as the seed’s answer, not yours. Run one page with
<code>--blind</code> and compare: that difference is the anchoring bias, and it
belongs in the write-up.</p>
<ol>${index.join("\n")}</ol></body></html>
`,
  );
  console.log(`\n  ${files.length} annotation page(s) → ${OUT}`);
  console.log(`  open ${join(OUT, "index.html")}\n`);
}

main();
