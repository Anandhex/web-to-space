/**
 * links/__tests__/slots.ts — what goes in each direction.
 *
 *   npm run test:slots
 *
 * The four rules `slots.ts` exists to keep identical across all four views:
 * the way back comes first and its direction takes nothing else, the rest of
 * the walked corridor follows, this page's links fill what is left in reading
 * order, and what does not fit is MARKED rather than dropped.
 *
 * Pure — no DOM, no three.js. `SpatialLink`s are built by hand here rather
 * than collected from a scene, because what is under test is the fill rule and
 * not the classifier (which `gold-set.ts` already scores).
 */
import { buildSlots, drawable, overflowCount } from "../slots";
import { enter, initNav, windowFor, type NavState } from "../memory";
import type { Region, Locus, SpatialLink } from "../types";

let checked = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  checked++;
  if (!cond) failures.push(detail ? `${name} — ${detail}` : name);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

let n = 0;
function link(region: Region, locus: Locus, label = `l${n}`): SpatialLink {
  n++;
  return {
    id: `p${n}`,
    href: `/${label}`,
    region,
    locus,
    label,
    host: null,
    resolved: `https://a.example/${label}`,
    synthesised: false,
    degenerate: false,
    citation: false,
    pageIndex: 0,
    anchorId: null,
    anchorPos: null,
    order: n,
    sameBlock: false,
    sourceText: null,
  };
}

const sibling = () => link("field", "same-site");
const external = () => link("field", "off-site");
const parent = () => link("ascent", "same-site");
const samePage = () => link("arrangement", "same-document");
const operational = () => link("page", "operational");

const WALL = windowFor("wall"); // up 2, down 2, left 3, right 3

// ── 1. Directions that do not travel take no slot ────────────────────────

{
  const slots = buildSlots({
    links: [samePage(), samePage(), operational(), operational()],
    nav: null,
    budget: WALL,
  });
  eq("pointers: nothing up", slots.up.length, 0);
  eq("pointers: nothing down", slots.down.length, 0);
  eq("pointers: nothing left", slots.left.length, 0);
  eq("pointers: nothing right", slots.right.length, 0);
}

// ── 2. Each kind lands on its own axis ───────────────────────────────────

{
  const slots = buildSlots({
    links: [parent(), sibling(), external(), samePage()],
    nav: null,
    budget: WALL,
  });
  eq("axes: one parent up", slots.up.length, 1);
  eq("axes: one sibling right", slots.right.length, 1);
  eq("axes: one external down", slots.down.length, 1);
  eq("axes: nothing left yet", slots.left.length, 0);
  eq("axes: everything is a link", slots.up[0].kind, "link");
  check("axes: a link carries its anchor id", Boolean(slots.right[0].linkId));
}

// ── 3. Reading order, and the window marks rather than drops ─────────────

{
  const links = Array.from({ length: 5 }, () => link("ascent", "same-site"));
  const slots = buildSlots({ links, nav: null, budget: WALL }); // up: 2

  eq("window: all five are present", slots.up.length, 5);
  eq("window: two are drawn", drawable(slots.up).length, 2);
  eq("window: three are marked", overflowCount(slots.up), 3);
  eq(
    "window: reading order is kept",
    slots.up.map((s) => s.label).join(" "),
    links.map((l) => l.label).join(" "),
  );
}

// ── 4. Lateral fills right, overflows left ───────────────────────────────

{
  const links = Array.from({ length: 7 }, () => link("field", "same-site"));
  const slots = buildSlots({ links, nav: null, budget: WALL }); // 3 a side

  eq("lateral: three right", slots.right.length, 3);
  eq("lateral: four left", slots.left.length, 4);
  eq("lateral: right all drawn", overflowCount(slots.right), 0);
  eq("lateral: the seventh is marked", overflowCount(slots.left), 1);
  eq(
    "lateral: the first three went right, in order",
    slots.right.map((s) => s.label).join(" "),
    links.slice(0, 3).map((l) => l.label).join(" "),
  );
}

// ── 5. Arrival reserves the way back, and it comes first ─────────────────

{
  let nav: NavState = initNav("https://a.example/", "a");
  nav = enter(nav, { url: "https://b.example/", label: "b", axis: "right" });

  const slots = buildSlots({
    links: [sibling(), sibling(), sibling(), sibling()],
    nav,
    budget: WALL,
  });

  eq("return: the way back is west", slots.left[0]?.url, "https://a.example/");
  eq("return: and it is first", slots.left[0]?.kind, "return");
  eq("return: it can be jumped to", typeof slots.left[0]?.historyIndex, "number");
  // West is reserved, so the four siblings all had to go east — and east only
  // has room for three. The fourth stays east and is marked; it must NOT be
  // spilled onto the return door, which is the whole point of reserving it.
  eq("return: nothing but the way back is west", slots.left.length, 1);
  eq("return: all four went east", slots.right.length, 4);
  eq("return: the fourth is marked", overflowCount(slots.right), 1);
  eq("return: east still drew its full three", drawable(slots.right).length, 3);
}

// ── 6. A walked corridor claims slots before the page's own links ────────

{
  let nav: NavState = initNav("https://0.example/", "0");
  for (let i = 1; i <= 3; i++)
    nav = enter(nav, { url: `https://${i}.example/`, label: String(i), axis: "right" });

  const slots = buildSlots({
    links: [parent(), parent(), parent()],
    nav,
    budget: WALL,
  });

  // Looking west: 2, 1, 0 — the whole retrace, the nearest one the way back.
  eq("corridor: three behind", slots.left.length, 3);
  eq("corridor: the nearest is the return", slots.left[0].kind, "return");
  eq("corridor: the rest are travelled", slots.left[1].kind, "travelled");
  eq("corridor: nearest first", slots.left[0].url, "https://2.example/");
  eq("corridor: furthest last", slots.left[2].url, "https://0.example/");
  // Up was untouched by the walk, so all three parents get their full budget.
  eq("corridor: up is unaffected", slots.up.length, 3);
  eq("corridor: two of them drawn", drawable(slots.up).length, 2);
}

// ── 7. Distances count outward from the reader ───────────────────────────

{
  let nav: NavState = initNav("https://0.example/", "0");
  for (let i = 1; i <= 2; i++)
    nav = enter(nav, { url: `https://${i}.example/`, label: String(i), axis: "up" });

  const slots = buildSlots({ links: [external(), external()], nav, budget: WALL });
  eq("distance: the way back is 1 away", slots.down[0].distance, 1);
  eq("distance: the next is 2", slots.down[1].distance, 2);
  // Externals go down, which is the RESERVED axis here. "Does not take a new
  // link" means none of them is DRAWN there — but they are still the page's
  // links, so they are marked rather than dropped and the view can offer them.
  eq(
    "distance: nothing new is drawn on the reserved axis",
    drawable(slots.down).filter((s) => s.kind === "link").length,
    0,
  );
  eq("distance: but neither external was dropped", overflowCount(slots.down), 2);
}

// ── Report ───────────────────────────────────────────────────────────────

for (const f of failures) console.error("  ✗ " + f);
console.log("");
console.log(`direction slots: ${checked - failures.length}/${checked} checks`);
console.log(failures.length === 0 ? "PASS" : `FAIL: ${failures.length} failing`);
process.exit(failures.length === 0 ? 0 : 1);
