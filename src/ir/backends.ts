import { Readability } from "@mozilla/readability";
import { PARSER_CONFIGS } from "./defaults";
import type { ParserBackend, ParserConfig } from "./types";

export interface BackendTransform {
  /** HTML string to feed into parsePageToIR (may differ from raw input). */
  html: string;
  /** ParserConfig overrides to merge on top of the user's settings. */
  configOverride: Partial<ParserConfig>;
  /** Human-readable label for the diagnostics bar. */
  label: string;
}

/**
 * Pre-processes raw HTML according to the selected parser backend before it
 * enters the XR pipeline.  The "flat" backend is handled in the renderer
 * and never reaches parsePageToIR; it is included here only for exhaustive
 * type coverage and returns the raw HTML unchanged.
 */
export function applyParserBackend(
  rawHtml: string,
  backend: ParserBackend,
  userConfig: Partial<ParserConfig>,
): BackendTransform {
  switch (backend) {
    case "readability": {
      try {
        const doc = new DOMParser().parseFromString(rawHtml, "text/html");
        const article = new Readability(doc).parse();
        return {
          html: article?.content ?? rawHtml,
          configOverride: userConfig,
          label: "Readability",
        };
      } catch {
        return { html: rawHtml, configOverride: userConfig, label: "Readability (fallback)" };
      }
    }

    case "naive": {
      return {
        html: rawHtml,
        configOverride: PARSER_CONFIGS.baseline,
        label: "Naive (Tags Only)",
      };
    }

    case "flat":
      return { html: rawHtml, configOverride: userConfig, label: "Browser Panel" };

    // VIPS runs its own internal parsePageToIR call with custom config.
    // usePipeline detects this case and calls parsePageWithVIPS directly.
    case "vips":
      return { html: rawHtml, configOverride: userConfig, label: "VIPS (Visual Blocks)" };

    // Web2VR bypasses the XR pipeline entirely — usePipeline returns null
    // plan/scene for this backend.  Web2VRScene handles rendering directly.
    case "web2vr":
      return { html: rawHtml, configOverride: userConfig, label: "Web2VR" };

    case "custom":
    default:
      return { html: rawHtml, configOverride: userConfig, label: "Custom Pipeline" };
  }
}
