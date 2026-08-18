/**
 * links/__tests__/gold-annotations.ts — the gold set.
 *
 * 174 anchors sampled from five documents in the census corpus, drawn by
 * `sample-anchors.ts` (a fixed stride through the document's anchors in DOM
 * order, so the sample spans the whole page rather than its head) and labelled
 * by reading the raw HTML around each one — the enclosing element chain, the
 * anchor tag and the sentence it sits in — never by reading what the
 * classifier decided.
 *
 * ── What this gold set is, and what it is not ──
 *
 * It is a SELF-CHECK, and it must be described that way in the thesis. A gold
 * set earns the name "gold" from being annotated by someone other than the
 * person who wrote the rules, ideally by two annotators with an inter-rater
 * agreement figure attached. This one was labelled by the author of
 * `classify.ts`, so it can catch a rule that does not do what it says, and it
 * cannot catch a rule that is wrong in a way its author also believes.
 * Independent annotation of the same 174 anchors is the cheap fix and it is
 * worth doing before the number is quoted.
 *
 * ── The labelling rules, stated so a second annotator can follow them ──
 *
 *  arrangement  the reference resolves inside THIS document (any `#fragment`,
 *               including citation superscripts and back-references)
 *  page         an action, not a place: a download, a mailto, an `href="#"`
 *               control, a page-apparatus control such as "edit this section"
 *  ascent       site navigation and the level up: menus, breadcrumbs, tab
 *               strips, footer link runs, category links, Wikipedia navboxes
 *               and interlanguage lists, a docs sidebar tree
 *  footing      citations and provenance: anything inside a reference list,
 *               bibliography, further-reading list, or a specifications table
 *  field        everything else that leads away — the default
 *
 * Where a label is genuinely arguable the entry carries a `note`, and those
 * notes are reported separately by the scorer. Hiding them would make the
 * headline accuracy look better than the evidence supports.
 */

import type { Region } from "../types";

export interface GoldAnchor {
  doc: string;
  href: string;
  /** Anchor text, trimmed. "" where the anchor wraps only an image. */
  text: string;
  region: Region;
  /** Set when the label is a judgement call rather than a reading of a rule. */
  note?: string;
}

const HYPERTEXT = "en.wikipedia.org-wiki-hypertext.html";
const INFO_ARCH = "en.wikipedia.org-wiki-information-architecture.html";
const MDN_WEBXR = "developer.mozilla.org-en-us-docs-web-api-webxr-device-api.html";
const WHATWG = "html.spec.whatwg.org-multipage-links.html.html";
const NNG = "www.nngroup.com-articles-ten-usability-heuristics.html";

export const GOLD: GoldAnchor[] = [
  // ── Wikipedia: Hypertext ────────────────────────────────────────────────
  { doc: HYPERTEXT, href: "#bodyContent", text: "Jump to content", region: "arrangement" },
  { doc: HYPERTEXT, href: "#", text: "(Top)", region: "page", note: "href='#' goes nowhere; it is a control, not a destination" },
  { doc: HYPERTEXT, href: "https://ca.wikipedia.org/wiki/Hipertext", text: "Català", region: "ascent" },
  { doc: HYPERTEXT, href: "https://hr.wikipedia.org/wiki/Hipertekst", text: "Hrvatski", region: "ascent" },
  { doc: HYPERTEXT, href: "https://pt.wikipedia.org/wiki/Hipertexto", text: "Português", region: "ascent" },
  { doc: HYPERTEXT, href: "/wiki/Hypertext", text: "Article", region: "ascent", note: "page-tab strip; the destination is this same page" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/File:Hyperlinks_scheme.svg", text: "", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Dendrogram", text: "Dendrogram", region: "ascent", note: "table[role=navigation] sidebar" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/List_of_concept-_and_mind-mapping_software", text: "List of concept- and mind-mapping software", region: "ascent" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Hyperlinks", text: "hyperlinks", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Compact_disc", text: "CDs", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Marshall_McLuhan", text: "Marshall McLuhan", region: "ascent", note: "collapsible sidebar with role=navigation" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Fanged_Noumena", text: "Fanged Noumena", region: "ascent" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/File:Ted_Nelson_cropped.jpg", text: "", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/NLS_(computer_system)", text: "NLS", region: "field" },
  { doc: HYPERTEXT, href: "#cite_note-17", text: "[17]", region: "arrangement", note: "a citation, but same-document: rule 5 gives it no body" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Macworld_Conference_&_Expo", text: "MacWorld convention", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Hypertext_Editing_System", text: "Hypertext Editing System", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Wiki", text: "Wikis", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Intermedia_(hypertext)", text: "Intermedia", region: "field" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Wikipedia:Verifiability", text: "verifying", region: "field", note: "maintenance hatnote pointing at a policy page" },
  { doc: HYPERTEXT, href: "/w/index.php?title=Hypertext&action=edit&section=9", text: "edit", region: "page", note: "page apparatus; needs a class/rel signal the pipeline does not carry" },
  { doc: HYPERTEXT, href: "https://www.wired.com/wired/archive/3.06/xanadu.html", text: '"The Curse of Xanadu"', region: "footing" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/ISBN_(identifier)", text: "ISBN", region: "footing" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Template:Cite_journal", text: "cite journal", region: "footing" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/PBS", text: "PBS", region: "footing" },
  { doc: HYPERTEXT, href: "https://hdl.handle.net/1956%2F6272", text: "1956/6272", region: "footing" },
  { doc: HYPERTEXT, href: "https://www.imdb.com/title/tt6475064/", text: "Hypertext", region: "field", note: "'External links' section — destinations, not evidence" },
  { doc: HYPERTEXT, href: "https://ui.adsabs.harvard.edu/abs/1987Compr..20i..17C", text: "1987Compr..20i..17C", region: "footing", note: "'Further reading' bibliography" },
  { doc: HYPERTEXT, href: "https://en.wiktionary.org/wiki/hypertext", text: "hypertext", region: "field", note: "sister-project side box" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Hyperdata", text: "Hyperdata", region: "ascent", note: "navbox" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Knowledge_representation_and_reasoning", text: "Knowledge representation and reasoning", region: "ascent" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Research_Resource_Identifier", text: "RRID", region: "ascent" },
  { doc: HYPERTEXT, href: "https://en.wikipedia.org/wiki/Metadata_Authority_Description_Schema", text: "MADS", region: "ascent" },
  { doc: HYPERTEXT, href: "https://lux.collections.yale.edu/view/concept/8402bdc0-cff1-41b9-b5e3-9a7b3a765931", text: "Yale LUX", region: "ascent", note: "authority-control navbox" },
  { doc: HYPERTEXT, href: "https://foundation.wikimedia.org/wiki/Special:MyLanguage/Policy:Privacy_policy", text: "Privacy Policy", region: "ascent" },

  // ── Wikipedia: Information architecture ─────────────────────────────────
  { doc: INFO_ARCH, href: "#bodyContent", text: "Jump to content", region: "arrangement" },
  { doc: INFO_ARCH, href: "/wiki/Wikipedia:File_upload_wizard", text: "Upload file", region: "ascent" },
  { doc: INFO_ARCH, href: "#User_experience", text: "1.1 User experience", region: "arrangement" },
  { doc: INFO_ARCH, href: "https://az.wikipedia.org/wiki/%C4%B0nformasiya_arxitekturas%C4%B1", text: "Azərbaycanca", region: "ascent" },
  { doc: INFO_ARCH, href: "https://hr.wikipedia.org/wiki/Strukturiranje_informacija", text: "Hrvatski", region: "ascent" },
  { doc: INFO_ARCH, href: "https://sv.wikipedia.org/wiki/Informationsarkitektur", text: "Svenska", region: "ascent" },
  { doc: INFO_ARCH, href: "/w/index.php?title=Information_architecture&action=history", text: "View history", region: "ascent" },
  { doc: INFO_ARCH, href: "/w/index.php?title=Special:DownloadAsPdf&page=Information_architecture&action=show-download-screen", text: "Download as PDF", region: "page", note: "a download; the URL carries no file extension to detect it by" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Information_society", text: "Society", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Computer_data_storage", text: "Computer data storage", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Internet_privacy", text: "Internet privacy", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Website", text: "websites", region: "field" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Concept", text: "concept", region: "field" },
  { doc: INFO_ARCH, href: "#cite_note-FOOTNOTEMorvilleRosenfeld2007-4", text: "[4]", region: "arrangement" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Information_retrieval", text: "information retrieval", region: "field" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Wikipedia:Citation_needed", text: "citation needed", region: "field", note: "marks the ABSENCE of a citation; the destination is a policy page" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Data_management", text: "Data management", region: "field" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Social_information_architecture", text: "Social information architecture", region: "field" },
  { doc: INFO_ARCH, href: "#cite_ref-What_2-1", text: "2", region: "arrangement", note: "back-reference from the reference list to the body" },
  { doc: INFO_ARCH, href: "#CITEREFMorvilleRosenfeld2007", text: "Morville & Rosenfeld 2007", region: "arrangement" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Doi_(identifier)", text: "doi", region: "footing" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/ISBN_(identifier)", text: "ISBN", region: "footing" },
  { doc: INFO_ARCH, href: "https://books.google.com/books?id=ntWc13nSiNkC", text: "Pervasive Information Architecture - Designing Cross-channel User Experiences", region: "footing" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Semantic_Web", text: "Semantic Web", region: "ascent", note: "navbox title" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Semantic_analytics", text: "Semantic analytics", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Folksonomy", text: "Folksonomy", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Reference_(computer_science)", text: "References", region: "ascent", note: "navbox entry whose TEXT is 'References' — a trap for a heading-based rule" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Turtle_(syntax)", text: "Turtle", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Rule_Interchange_Format", text: "Rule Interchange Format", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/Bibliographic_Ontology", text: "BIBO", region: "ascent" },
  { doc: INFO_ARCH, href: "https://en.wikipedia.org/wiki/H-feed", text: "h-feed", region: "ascent" },
  { doc: INFO_ARCH, href: "/wiki/Category:Information_governance", text: "Information governance", region: "ascent", note: "category links are the level up" },
  { doc: INFO_ARCH, href: "/wiki/Wikipedia:Text_of_the_Creative_Commons_Attribution-ShareAlike_4.0_International_License", text: "Creative Commons Attribution-ShareAlike 4.0 License", region: "ascent" },
  { doc: INFO_ARCH, href: "https://foundation.wikimedia.org/wiki/Special:MyLanguage/Policy:Cookie_statement", text: "Cookie statement", region: "ascent" },

  // ── MDN: WebXR Device API ───────────────────────────────────────────────
  { doc: MDN_WEBXR, href: "#content", text: "Skip to main content", region: "arrangement" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/HTML/Reference", text: "See all…", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/CSS", text: "CSS: Styling language", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/CSS/Guides/Animations/Using", text: "Animations", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/JavaScript", text: "JavaScript: Scripting language", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration", text: "Loops and iteration", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/HTML_DOM_API", text: "HTML DOM API", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/Web_Workers_API/Using_web_workers", text: "Using web workers", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/WebDriver", text: "WebDriver", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Learn_web_development/Getting_started", text: "Getting started modules", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Learn_web_development/Core/Scripting", text: "Dynamic scripting with JavaScript module", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/CSS/Guides/Shapes/Shape_generator", text: "Shape generator", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebXR_Device_API", text: "WebXR Device API", region: "ascent", note: "breadcrumb" },
  { doc: MDN_WEBXR, href: "#browser_compatibility", text: "Browser compatibility table", region: "arrangement" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/Navigator/xr", text: "navigator.xr", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRSpace", text: "XRSpace", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRRigidTransform", text: "XRRigidTransform", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRInputSourceEvent", text: "XRInputSourceEvent", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRProjectionLayer", text: "XRProjectionLayer", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRAnchor", text: "XRAnchor", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRHitTestResult", text: "XRHitTestResult", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebXR_Device_API/Lifecycle", text: "WebXR application life cycle", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebXR_Device_API/Lighting", text: "Lighting a WebXR setting", region: "field" },
  { doc: MDN_WEBXR, href: "https://immersive-web.github.io/webxr/", text: "WebXR Device API", region: "footing", note: "Specifications table — provenance, which the footing is for" },
  { doc: MDN_WEBXR, href: "https://immersive-web.github.io/layers/", text: "WebXR Layers API Level 1", region: "footing", note: "Specifications table" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/Canvas_API/Tutorial", text: "Canvas tutorial", region: "field" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown", text: "Starting up and shutting down a WebXR session", region: "ascent", note: "docs sidebar tree" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebXR_Device_API/Bounded_reference_spaces", text: "Using bounded reference spaces", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRCPUDepthInformation", text: "XRCPUDepthInformation", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRPose", text: "XRPose", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRSystem", text: "XRSystem", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/WebGLRenderingContext/makeXRCompatible", text: "WebGLRenderingContext.makeXRCompatible()", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Web/API/XRSession/selectstart_event", text: "XRSession: selectstart", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/about", text: "About", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/MDN/Community", text: "Community resources", region: "ascent" },
  { doc: MDN_WEBXR, href: "/en-US/docs/Glossary", text: "Glossary", region: "ascent" },

  // ── WHATWG HTML: Links ──────────────────────────────────────────────────
  { doc: WHATWG, href: "https://whatwg.org/", text: "", region: "ascent", note: "masthead logo link" },
  { doc: WHATWG, href: "forms.html#the-form-element", text: "form", region: "field", note: "another page of the same spec — a real destination, not this document" },
  { doc: WHATWG, href: "#attr-hyperlink-href", text: "href", region: "arrangement" },
  { doc: WHATWG, href: "https://infra.spec.whatwg.org/#ascii-digit", text: "ASCII digits", region: "field" },
  { doc: WHATWG, href: "#dom-hyperlink-host", text: "host", region: "arrangement" },
  { doc: WHATWG, href: "https://webidl.spec.whatwg.org/#this", text: "this", region: "field" },
  { doc: WHATWG, href: "https://url.spec.whatwg.org/#concept-url-host", text: "host", region: "field" },
  { doc: WHATWG, href: "https://url.spec.whatwg.org/#port-state", text: "port state", region: "field" },
  { doc: WHATWG, href: "https://url.spec.whatwg.org/#basic-url-parser-state-override", text: "state override", region: "field" },
  { doc: WHATWG, href: "https://w3c.github.io/FileAPI/#BlobURLStore", text: "Blob URL Store", region: "field" },
  { doc: WHATWG, href: "text-level-semantics.html#the-a-element", text: "a", region: "field" },
  { doc: WHATWG, href: "nav-history-apis.html#fire-navigate-download-sourceelement", text: "sourceElement", region: "field" },
  { doc: WHATWG, href: "https://w3c.github.io/webdriver-bidi/#webdriver-bidi-navigation-status", text: "WebDriver BiDi navigation status", region: "field" },
  { doc: WHATWG, href: "urls-and-fetching.html#encoding-parsing-a-url", text: "parsed", region: "field" },
  { doc: WHATWG, href: "#ping", text: "ping", region: "arrangement" },
  { doc: WHATWG, href: "#internal-resource-link", text: "Internal Resource", region: "arrangement" },
  { doc: WHATWG, href: "browsing-the-web.html#navigate", text: "navigation", region: "field" },
  { doc: WHATWG, href: "dom.html#language", text: "language", region: "field" },
  { doc: WHATWG, href: "browsers.html#concept-origin", text: "origin", region: "field" },
  { doc: WHATWG, href: "semantics.html#the-link-element", text: "link", region: "field" },
  { doc: WHATWG, href: "#link-type-external", text: "external", region: "arrangement" },
  { doc: WHATWG, href: "https://fetch.spec.whatwg.org/#http-scheme", text: "HTTP(S) scheme", region: "field" },
  { doc: WHATWG, href: "dom.html#concept-document-module-map", text: "module map", region: "field" },
  { doc: WHATWG, href: "semantics.html#attr-link-fetchpriority", text: "fetchpriority", region: "field" },
  { doc: WHATWG, href: "document-sequences.html#auxiliary-browsing-context", text: "auxiliary browsing context", region: "field" },
  { doc: WHATWG, href: "#external-resource-link", text: "external resource link", region: "arrangement" },
  { doc: WHATWG, href: "semantics.html#fetch-and-process-the-linked-resource", text: "fetch and process", region: "field" },
  { doc: WHATWG, href: "parsing.html#delay-the-load-event", text: "delay the load event", region: "field" },
  { doc: WHATWG, href: "nav-history-apis.html#concept-document-window", text: "associated Document", region: "field" },
  { doc: WHATWG, href: "semantics.html#link-options-integrity", text: "integrity", region: "field" },
  { doc: WHATWG, href: "#preload", text: "preload", region: "arrangement" },
  { doc: WHATWG, href: "semantics.html#attr-link-href", text: "href", region: "field" },
  { doc: WHATWG, href: "https://fetch.spec.whatwg.org/#concept-request", text: "request", region: "field" },
  { doc: WHATWG, href: "https://dom.spec.whatwg.org/#concept-event-fire", text: "Fire an event", region: "field" },

  // ── NN/g: Ten usability heuristics ──────────────────────────────────────
  { doc: NNG, href: "#main", text: "Skip to content", region: "arrangement" },
  { doc: NNG, href: "/training/live-courses/", text: "Upcoming Live Online Training", region: "ascent" },
  { doc: NNG, href: "/ux-certification/", text: "UX Certification", region: "ascent" },
  { doc: NNG, href: "/reports/", text: "Reports & Books", region: "ascent" },
  { doc: NNG, href: "/consulting/expert-review/", text: "Expert Review", region: "ascent" },
  { doc: NNG, href: "/faqs/", text: "FAQs", region: "ascent" },
  { doc: NNG, href: "#", text: "Share", region: "page", note: "href='#' — a share control" },
  { doc: NNG, href: "https://www.nngroup.com/people/kelley-gordon/", text: "Kelley Gordon", region: "field" },
  { doc: NNG, href: "#toc-2-match-between-the-system-and-the-real-world-2", text: "2: Match Between the System and the Real World", region: "arrangement" },
  { doc: NNG, href: "#toc-6-recognition-rather-than-recall-6", text: "6: Recognition Rather than Recall", region: "arrangement" },
  { doc: NNG, href: "#toc-10-help-and-documentation-10", text: "10: Help and Documentation", region: "arrangement" },
  { doc: NNG, href: "https://www.nngroup.com/articles/visibility-system-status/", text: "Full article: Visibility of System Status", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/match-system-real-world/", text: "Full article: Match Between the System and the Real World", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/videos/jakobs-law-internet-ux/", text: "Jakob's Law", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/videos/design-systems/", text: "family of products (internal consistency).", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/videos/slips-vs-mistakes/", text: "slips and mistakes", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/slips/", text: "Full article: Preventing User Errors", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/videos/recognition-vs-recall/", text: "3-minute video: Recognition vs. Recall", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/flexibility-efficiency-heuristic/", text: "Full article: Flexibility and Efficiency of Use: The 7th Usability Heuristic Explained", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/principles-visual-design/", text: "visual design", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/error-message-guidelines/", text: "error-message", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/search-visible-and-simple/", text: "search", region: "field" },
  { doc: NNG, href: "https://www.nngroup.com/articles/usability-heuristics-complex-applications/", text: "10 Usability Heuristics Applied to Complex Applications", region: "field" },
  { doc: NNG, href: "http://www.zenhaiku.com/archives/usability_applied_to_life.html", text: "10 Usability Heuristics Applied to Everyday Life", region: "field" },
  { doc: NNG, href: "//media.nngroup.com/media/articles/attachments/Jakob's10UsabilityHeuristics_AllPosters_5.zip", text: "All Posters - 10 Usability Heuristics (ZIP)", region: "page", note: "a .zip download" },
  { doc: NNG, href: "/topic/heuristic-evaluation/", text: "Heuristic Evaluation", region: "field", note: "'related topics' aside; the model has no relatedness district, so it leads away like anything else" },
  { doc: NNG, href: "/videos/usability-heuristic-user-control-freedom/?lm=ten-usability-heuristics&pt=article", text: "Usability Heuristic 3: User Control & Freedom Aurora Harley · 2 min", region: "field" },
  { doc: NNG, href: "/articles/how-to-conduct-a-heuristic-evaluation/?lm=ten-usability-heuristics&pt=article", text: "How to Conduct a Heuristic Evaluation Kate Moran and Kelley Gordon · 6 min", region: "field" },
  { doc: NNG, href: "/contents/train-your-team/group-discount-pricing/", text: "Group-Discount Pricing", region: "ascent" },
  { doc: NNG, href: "/consulting/user-research/", text: "Customized Research", region: "ascent" },
  { doc: NNG, href: "/terms-and-conditions/", text: "Terms & Conditions", region: "ascent" },
  { doc: NNG, href: "/about/", text: "About NNGroup", region: "ascent" },
  { doc: NNG, href: "/cookie-declaration/", text: "Cookie Declaration", region: "ascent" },
  { doc: NNG, href: "https://www.threads.com/@nngux", text: "Threads", region: "ascent", note: "footer social row" },
];
