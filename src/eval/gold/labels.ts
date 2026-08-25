/**
 * eval/gold/labels.ts — the annotation vocabulary.
 *
 * `IRRole` has 50+ members. Humans cannot apply that consistently and any
 * inter-annotator agreement computed over it would be meaningless, so the gold
 * standard is annotated in a collapsed 13-label space and every system's output
 * is projected into the same space before scoring. The collapse is published
 * (docs/annotation-guidelines.md) and its bias is toward UNDERSTATING the
 * difference between systems — two parsers that disagree only about
 * `paragraph` vs `text` are scored identical.
 */
import type { IRRole } from "../../ir/types";

export const GOLD_LABELS = [
  "main-content",
  "heading",
  "prose",
  "list",
  "navigation",
  "complementary",
  "figure",
  "media",
  "table",
  "control",
  "code",
  "chrome",
  "other",
] as const;

export type GoldLabel = (typeof GOLD_LABELS)[number];

/**
 * The 14th value a *system* can produce but an annotator cannot: the gold unit
 * has no counterpart in the system's output at all. Content extraction deletes
 * whole subtrees, so this is a real and frequent prediction — folding it into
 * `other` would hide the single biggest failure mode of the Readability family.
 */
export const ABSENT = "absent" as const;
export type PredictedLabel = GoldLabel | typeof ABSENT;

/** Columns of the confusion matrix: every gold label plus `absent`. */
export const PREDICTED_LABELS: PredictedLabel[] = [...GOLD_LABELS, ABSENT];

/** Short forms for figure axes — full names do not fit a 14-column heatmap. */
export const LABEL_ABBREV: Record<PredictedLabel, string> = {
  "main-content": "main",
  heading: "head",
  prose: "prose",
  list: "list",
  navigation: "nav",
  complementary: "compl",
  figure: "fig",
  media: "media",
  table: "table",
  control: "ctrl",
  code: "code",
  chrome: "chrome",
  other: "other",
  absent: "∅",
};

/**
 * `IRRole` → gold label. Every member of the union must appear; the exhaustive
 * `Record` type is the check that a new role cannot be added to the parser
 * without a decision about how it is scored.
 */
export const IR_ROLE_TO_GOLD: Record<IRRole, GoldLabel> = {
  // Containers that carry the document's substance.
  main: "main-content",
  article: "main-content",
  region: "main-content",
  document: "main-content",
  feed: "list",

  heading: "heading",

  paragraph: "prose",
  text: "prose",
  blockquote: "prose",

  list: "list",
  listitem: "list",

  navigation: "navigation",
  // A bare link outside prose is a navigation affordance in the XR scene.
  link: "navigation",

  complementary: "complementary",
  // `group` is the parser's catch-all sectioning container, and an unlabelled
  // aside-like block is what an annotator calls `complementary` — but it is ALSO
  // the role of `<thead>`/`<tbody>`/`<tfoot>` and `<fieldset>`, which are not
  // asides by anyone's reading. `goldFromIRNode` looks at the source tag before
  // falling back to this entry; see the note there.
  group: "complementary",

  img: "figure",
  figure: "figure",
  caption: "figure",

  video: "media",
  audio: "media",

  table: "table",
  row: "table",
  cell: "table",
  columnheader: "table",
  rowheader: "table",
  grid: "table",

  button: "control",
  textbox: "control",
  searchbox: "control",
  checkbox: "control",
  radio: "control",
  combobox: "control",
  slider: "control",
  spinbutton: "control",
  switch: "control",
  option: "control",
  form: "control",
  search: "control",

  code: "code",

  banner: "chrome",
  contentinfo: "chrome",

  separator: "other",
  dialog: "other",
  status: "other",
  alert: "other",
  tooltip: "other",
  timer: "other",
  marquee: "other",
  progressbar: "other",
  presentation: "other",
  none: "other",
  generic: "other",
};

export function goldFromIRRole(role: IRRole): GoldLabel {
  return IR_ROLE_TO_GOLD[role] ?? "other";
}

/**
 * Row groups and field sets by their source tag. `group` is one IR role
 * covering three unrelated things, and collapsing all of them to
 * `complementary` translated a table's `<tbody>` into an aside: 342 rowgroups
 * on the corpus, which alone put `complementary` precision at 0.02.
 *
 * The guidelines already answer both cases — "tables and their cells are
 * `table`" and "a form and everything in it is `control`" — so this is a
 * mistranslation being corrected, not a new judgement. The parser was right;
 * the collapse to 13 labels lost the distinction.
 */
const GROUP_TAG_TO_GOLD: Record<string, GoldLabel> = {
  thead: "table",
  tbody: "table",
  tfoot: "table",
  fieldset: "control",
  // A disclosure widget is not an aside. `other` is what the vocabulary has for
  // "a thing, but none of the twelve" — GUIDELINE GAP: §3 does not rule on
  // `<details>`, and an annotator could equally argue `control`. Settle it
  // before a second annotator meets one.
  details: "other",
};

/**
 * The gold label for one IR node. Prefer this over `goldFromIRRole`: a few roles
 * are ambiguous on their own and the node's `sourceTag` resolves them.
 */
export function goldFromIRNode(node: {
  role: IRRole;
  sourceTag: string | null;
}): GoldLabel {
  if (node.role === "group" && node.sourceTag) {
    const bySource = GROUP_TAG_TO_GOLD[node.sourceTag];
    if (bySource) return bySource;
  }
  return goldFromIRRole(node.role);
}

/**
 * What a TAGS-ONLY reader knows: HTML tag → the gold label it directly implies.
 *
 * This is the knowledge the `naive` baseline has and nothing more. It is the
 * definition of a DECLARED unit: if the tag yields the annotator's label, the
 * markup told you, and recovering it demonstrates nothing. Everything else is
 * HIDDEN — either the tag is generic (`div`, `span`) or it implies something the
 * annotator disagreed with — and only structural inference can reach it.
 *
 * `section` maps to `main-content` because in this vocabulary a declared region
 * IS main content; `header`/`footer` map to `chrome` per HTML-AAM's page-level
 * rule, which is where the pipeline drops them.
 */
const TAG_IMPLIES_GOLD: Record<string, GoldLabel> = {
  main: "main-content", article: "main-content", section: "main-content",
  nav: "navigation",
  aside: "complementary",
  header: "chrome", footer: "chrome",
  h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading",
  p: "prose", blockquote: "prose",
  // Inline text. A tag reader calls these prose without inferring anything, so
  // counting them as hidden would pad the subset with units that were never in
  // question. `<a>` is deliberately NOT here: whether a link is navigation or
  // running prose depends on its context, which is exactly the inference under
  // test.
  span: "prose", time: "prose", bdi: "prose", em: "prose", strong: "prose",
  small: "prose", i: "prose", b: "prose", abbr: "prose", cite: "prose",
  ul: "list", ol: "list", dl: "list", li: "list", dt: "list", dd: "list",
  table: "table", thead: "table", tbody: "table", tfoot: "table",
  tr: "table", td: "table", th: "table", caption: "table",
  figure: "figure", figcaption: "figure", img: "figure", picture: "figure",
  video: "media", audio: "media",
  code: "code", pre: "code", samp: "code", kbd: "code",
  form: "control", fieldset: "control", input: "control", button: "control",
  select: "control", textarea: "control", label: "control",
  dialog: "other", details: "other", hr: "other",
};

/**
 * True when the markup itself hands you this unit's label — an explicit `role=`
 * that matches, or a tag that directly implies it. False = a HIDDEN unit.
 */
export function isMarkupDeclared(tag: string, role: string | null, gold: GoldLabel): boolean {
  if (role && role.trim() !== "" && goldFromAXRole(role.trim()) === gold) return true;
  return TAG_IMPLIES_GOLD[tag.toLowerCase()] === gold;
}

/**
 * Chrome-computed accessibility-tree roles → gold label. Used by the AX-tree
 * baseline. AX role names are ARIA role names plus a handful of Blink-internal
 * ones (`RootWebArea`, `LineBreak`, …), so the ARIA table is reused and the
 * extras are listed explicitly. Anything unknown is `other`, which is the
 * conservative direction for a baseline we are trying not to strawman.
 */
const AX_EXTRA_TO_GOLD: Record<string, GoldLabel> = {
  RootWebArea: "main-content",
  WebArea: "main-content",
  StaticText: "prose",
  InlineTextBox: "prose",
  LineBreak: "other",
  GenericContainer: "other",
  Section: "main-content",
  LayoutTable: "table",
  LayoutTableRow: "table",
  LayoutTableCell: "table",
  DescriptionList: "list",
  DescriptionListTerm: "list",
  DescriptionListDetail: "list",
  Details: "other",
  Summary: "heading",
  Pre: "code",
  Abbr: "prose",
  Time: "prose",
  Mark: "prose",
  Emphasis: "prose",
  Strong: "prose",
  Header: "chrome",
  Footer: "chrome",
  Legend: "heading",
  Iframe: "media",
  Canvas: "figure",
  SvgRoot: "figure",
  Image: "figure",
  ListMarker: "list",
  MenuListPopup: "control",
  MenuListOption: "control",
  ComboBoxSelect: "control",
  TextFieldWithComboBox: "control",
  Paragraph: "prose",
  Link: "navigation",
  ListItem: "list",
  List: "list",
  Heading: "heading",
  Main: "main-content",
  Navigation: "navigation",
  Complementary: "complementary",
  Banner: "chrome",
  ContentInfo: "chrome",
  Article: "main-content",
  Blockquote: "prose",
  Figure: "figure",
  Figcaption: "figure",
  Table: "table",
  Row: "table",
  Cell: "table",
  ColumnHeader: "table",
  RowHeader: "table",
  Video: "media",
  Audio: "media",
  Code: "code",
  Form: "control",
  Search: "control",
  SearchBox: "control",
  TextField: "control",
  Button: "control",
  CheckBox: "control",
  RadioButton: "control",
  Slider: "control",
  SpinButton: "control",
  Switch: "control",
  Dialog: "other",
  Alert: "other",
  Status: "other",
  ProgressIndicator: "other",
  Splitter: "other",
  Tooltip: "other",
  Presentational: "other",
  Ignored: "other",
};

export function goldFromAXRole(axRole: string): GoldLabel {
  const extra = AX_EXTRA_TO_GOLD[axRole];
  if (extra) return extra;
  const aria = axRole.toLowerCase();
  if (aria in IR_ROLE_TO_GOLD) {
    return IR_ROLE_TO_GOLD[aria as IRRole];
  }
  return "other";
}

/** Label ordering used consistently across every figure and table. */
export function labelIndex(l: PredictedLabel): number {
  return PREDICTED_LABELS.indexOf(l);
}
