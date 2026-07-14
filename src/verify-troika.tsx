import { Text } from "troika-three-text";

const out = document.getElementById("out")!;
const log = (s: string) => (out.textContent += "\n" + s);

function measure(opts: {
  text: string;
  maxWidth: number;
  fontSize: number;
  curveRadius?: number;
}): Promise<{ glyphs: number; lines: number }> {
  return new Promise((resolve) => {
    const t = new Text();
    t.text = opts.text;
    t.fontSize = opts.fontSize;
    t.maxWidth = opts.maxWidth;
    t.anchorX = "left";
    t.anchorY = "top";
    t.lineHeight = 1.4;
    if (opts.curveRadius !== undefined) (t as any).curveRadius = opts.curveRadius;
    t.sync(() => {
      const info: any = (t as any).textRenderInfo;
      const glyphs = info?.glyphAtlasIndices?.length ?? -1;
      // count distinct baseline Y positions among caret positions → visual lines
      const caret: Float32Array | undefined = info?.caretPositions;
      const ys = new Set<number>();
      if (caret) for (let i = 3; i < caret.length; i += 4) ys.add(Math.round(caret[i] * 1000));
      resolve({ glyphs, lines: ys.size });
    });
  });
}

const nonWs = (s: string) => s.replace(/\s/g, "").length;

async function run() {
  out.textContent = "troika curveRadius glyph-drop test";
  const alert = "Assertive alert — something needs attention now.";
  const heading = "16. Alerts & Status";
  const quote =
    "This is a block quotation. It should map to an XRBlockQuote with its own distinct visual treatment and a vertical accent rule.";

  const cases: Array<[string, string, number, number | undefined]> = [
    // label, text, maxWidth, curveRadius
    ["heading  flat   ", heading, 1.296, undefined],
    ["heading  curve  ", heading, 1.296, 0.96],
    ["alert    flat   ", alert, 1.264, undefined],
    ["alert    curve  ", alert, 1.264, 0.96],
    ["alert    curveNEG", alert, 1.264, -0.96],
    ["quote    flat   ", quote, 1.27, undefined],
    ["quote    curve  ", quote, 1.27, 0.96],
  ];

  for (const [label, text, mw, cr] of cases) {
    const r = await measure({ text, maxWidth: mw, fontSize: 0.024, curveRadius: cr });
    const expected = nonWs(text);
    const flag = r.glyphs >= 0 && r.glyphs < expected ? "  <<< DROPPED GLYPHS" : "";
    log(
      `${label} | expected=${expected} rendered=${r.glyphs} lines=${r.lines}${flag}`,
    );
  }
  log("done");
}

run();
