/**
 * links/__tests__/direction.ts — the projection table, asserted.
 *
 * `direction.ts` is a pure re-projection of (region, locus) onto five kinds,
 * so it is exhaustively testable: 5 regions × 5 loci is 25 cases and every one
 * of them is written down here. `gold-set.ts` runs this before it scores the
 * corpus, so `npm run test:links` fails on a changed table even if the corpus
 * happens not to contain an example of the cell that changed.
 *
 * Lateral overflow is checked too — the default (fill right, overflow left) is
 * a deferred decision, and a test is what makes it a decision rather than an
 * accident.
 */
import { assignLateralSides, directionFor, markFor } from "../direction";
import type { LinkDirection } from "../direction";
import type { Locus, Region } from "../types";

const LOCI: Locus[] = [
  "same-document",
  "same-site",
  "off-site",
  "operational",
  "unknown",
];

/** rows = region, columns = LOCI in the order above. */
const TABLE: Record<Region, LinkDirection[]> = {
  //            same-document  same-site  off-site  operational  unknown
  page: ["inline", "inline", "inline", "inline", "inline"],
  ascent: ["up", "up", "up", "up", "up"],
  arrangement: ["here", "here", "here", "here", "here"],
  field: ["here", "lateral", "down", "inline", "down"],
  // `footing` collapses onto exactly the `field` row — that IS the collapse.
  footing: ["here", "lateral", "down", "inline", "down"],
};

export interface TableResult {
  checked: number;
  failures: string[];
}

export function runDirectionTable(): TableResult {
  const failures: string[] = [];
  let checked = 0;

  for (const region of Object.keys(TABLE) as Region[]) {
    TABLE[region].forEach((want, i) => {
      const locus = LOCI[i];
      const got = directionFor(region, locus);
      checked++;
      if (got !== want)
        failures.push(`directionFor(${region}, ${locus}) = ${got}, want ${want}`);
    });
  }

  // The marks are a legend the reader memorises; a silent change to one is a
  // change to the legend, so they are pinned.
  const marks: [LinkDirection, string][] = [
    ["up", "▴"],
    ["lateral", "▸"],
    ["here", "•"],
    ["down", "▾"],
    ["inline", ""],
  ];
  for (const [d, want] of marks) {
    checked++;
    if (markFor(d) !== want)
      failures.push(`markFor(${d}) = ${JSON.stringify(markFor(d))}, want ${JSON.stringify(want)}`);
  }

  // Lateral overflow: 7 siblings against a 3-per-side window fills right 0–2,
  // left 3–5, and reports the 7th as overflow rather than dropping it.
  const sides = assignLateralSides([0, 1, 2, 3, 4, 5, 6], 3);
  checked++;
  if (sides.length !== 7) failures.push("assignLateralSides dropped a sibling");
  const shape = sides.map((s) => `${s.side}${s.slot}${s.overflow ? "!" : ""}`).join(" ");
  checked++;
  if (shape !== "right0 right1 right2 left0 left1 left2 left3!")
    failures.push(`assignLateralSides shape = "${shape}"`);

  return { checked, failures };
}

// Runnable on its own: `npx tsx src/links/__tests__/direction.ts`
if (process.argv[1]?.endsWith("direction.ts")) {
  const { checked, failures } = runDirectionTable();
  for (const f of failures) console.error("  ✗ " + f);
  console.log(`direction table: ${checked - failures.length}/${checked} cases`);
  process.exit(failures.length === 0 ? 0 : 1);
}
