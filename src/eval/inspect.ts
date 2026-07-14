import "./dom-bootstrap";
if (!(globalThis as any).CSS) {
  (globalThis as any).CSS = {
    escape: (s: string) => s.replace(/["\\]/g, "\\$&"),
    supports: () => false,
  };
}
import * as fs from "fs";
import { parsePageToIR } from "../ir/parser";
import { mapIRToScene } from "../mapper/mapper";
import { DEFAULT_MAPPER_CONFIG } from "../mapper/mapper";
import { computeLayoutPlan } from "../layout/engine";
import { QUEST_3_PROFILE } from "../layout/profiles";
import type { XRPrimitive } from "../mapper/types";
import type { LayoutPlan } from "../layout/types";

async function main() {
  const file = process.env.HTMLFILE ?? "public/test-elements.html";
  const html = fs.readFileSync(file, "utf-8");
  const ir = await parsePageToIR(html, "https://localhost/");
  const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
  const plan: LayoutPlan = computeLayoutPlan(scene, QUEST_3_PROFILE, undefined, {});
  console.log("UNPLACED:", JSON.stringify(plan.diagnostics.unplacedIds));

  const byId = new Map<string, XRPrimitive>();
  const walk = (n: XRPrimitive, depth: number, parentType: string) => {
    byId.set(n.id, n);
    (n.children ?? []).forEach((c) => walk(c, depth + 1, n.type));
  };
  walk(scene.root, 0, "");

  const target = process.argv[2] ?? "quote";

  // Print subtree of any primitive whose label/content/type matches target
  const printTree = (n: XRPrimitive, depth: number) => {
    const e = plan.entries[n.id];
    const text =
      (n as any).content ?? (n as any).label ?? (n as any).text ?? "";
    const pos = e ? `pos=(${e.position.x.toFixed(3)},${e.position.y.toFixed(3)},${e.position.z.toFixed(3)}) size=(${e.size.width.toFixed(3)}x${e.size.height.toFixed(3)}) pg=${e.pageIndex}` : "NO-ENTRY";
    console.log(
      "  ".repeat(depth) +
        `${n.type} [${n.id}] ${pos}  "${String(text).slice(0, 40).replace(/\n/g, "\\n")}"`,
    );
    (n.children ?? []).forEach((c) => printTree(c, depth + 1));
  };

  const matches: XRPrimitive[] = [];
  const findMatch = (n: XRPrimitive) => {
    const hay = `${n.id} ${n.type} ${(n as any).label ?? ""} ${(n as any).content ?? ""} ${(n as any).text ?? ""}`.toLowerCase();
    if (hay.includes(target.toLowerCase())) matches.push(n);
    (n.children ?? []).forEach(findMatch);
  };
  findMatch(scene.root);

  if (process.env.DUMP) {
    for (const m of matches.slice(0, 4)) {
      console.log("DUMP", m.id, JSON.stringify({
        type: m.type,
        label: (m as any).label,
        content: (m as any).content,
        text: (m as any).text,
        children: (m.children ?? []).map((c) => ({ id: c.id, type: c.type, text: (c as any).text, label: (c as any).label })),
      }));
    }
    return;
  }

  console.log(`=== matches for "${target}": ${matches.length} ===`);
  for (const m of matches.slice(0, 3)) {
    console.log("--- subtree ---");
    printTree(m, 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
