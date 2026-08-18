/**
 * scene/use-pipeline.ts
 *
 * usePipeline() runs the HTML→IR→scene→layout pipeline (memoised) and returns
 * the LayoutPlan the renderer draws.
 */
import { useState, useEffect, useMemo } from "react";
import { parsePageToIR } from "../../ir/parser";
import { parsePageWithVIPSDetailed } from "../../ir/vips";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../../mapper/mapper";
import { computeLayoutPlan } from "../../layout/engine";
import { foldSceneContentOnly } from "../../layout/content-only";
import { DEFAULT_CONFIG } from "../../ir/defaults";
import { applyParserBackend } from "../../ir/backends";
import { createAIProvider, aiSettingsReady } from "../../ir/ai";
import type { AIProviderSettings, AIBatchReport } from "../../ir/ai";
import type { ParserConfig, ParserBackend } from "../../ir/types";
import type { SemanticScene } from "../../mapper/types";
import type {
  LayoutPlan,
  DeviceProfile,
  LayoutConfig,
} from "../../layout/types";

export function usePipeline(
  html: string | undefined,
  sceneIn: SemanticScene | undefined,
  url: string | undefined,
  deviceProfile: DeviceProfile,
  layoutConfig: Partial<LayoutConfig>,
  parserConfig: Partial<ParserConfig>,
  parserBackend: ParserBackend,
  arrangement: import("../../layout/types").Arrangement | undefined,
  /**
   * Layer 3's provider config, from the Home screen. `null` (or settings with
   * no key) means the parser runs with its stub provider and every node keeps
   * the role the structural layers gave it.
   */
  aiSettings: AIProviderSettings | null,
) {
  const [result, setResult] = useState({
    scene: null as SemanticScene | null,
    plan: null as LayoutPlan | null,
    error: null as string | null,
    backendLabel: "Custom Pipeline" as string,
    /** What layer 3 did on the last parse — for the status line only. */
    aiReport: null as AIBatchReport | null,
  });

  const configHash = JSON.stringify(layoutConfig);
  const stableConfig = useMemo(() => layoutConfig, [configHash]);
  const parserConfigHash = JSON.stringify(parserConfig);
  const stableParserConfig = useMemo(() => parserConfig, [parserConfigHash]);
  // Same treatment as the two configs above: the caller rebuilds this object
  // every render, and an identity change here would re-parse the page.
  const aiHash = JSON.stringify(aiSettings);
  const stableAI = useMemo(() => aiSettings, [aiHash]);

  useEffect(() => {
    let cancelled = false;

    // Filled in by the provider's report hook during the parse below, then
    // published with the result — a ref would outlive the run, and state
    // during it would re-render mid-parse.
    let aiReport: AIBatchReport | null = null;

    async function run() {
      // "flat" and "web2vr" skip the XR pipeline entirely.
      // The renderer handles each as its own non-pipeline visual.
      if (parserBackend === "flat" || parserBackend === "web2vr") {
        if (!cancelled)
          setResult({
            scene: null,
            plan: null,
            error: null,
            backendLabel:
              parserBackend === "web2vr" ? "Web2VR" : "Browser Panel",
            aiReport: null,
          });
        return;
      }

      // Content-only page views: fold banner/aside/footer landmarks into the
      // content panel's flow BEFORE layout, so they paginate inline (pure
      // scene→scene — the input scene is never mutated).
      const maybeFold = (s: SemanticScene): SemanticScene =>
        arrangement?.pageDistribution && arrangement.pageDistribution !== "flip"
          ? foldSceneContentOnly(s)
          : s;

      try {
        let scene: SemanticScene;
        if (sceneIn) {
          scene = maybeFold(sceneIn);
        } else if (html) {
          let ir;
          let label: string;

          if (parserBackend === "vips") {
            // The label comes from the run itself: VIPS reports whether it got
            // a rendered frame (the real algorithm) or fell back to the
            // rendering-free approximation, and the diagnostics bar must not
            // claim the former when it did the latter.
            const vips = await parsePageWithVIPSDetailed(html, url!);
            ir = vips.ir;
            label = vips.diagnostics.label;
          } else {
            // Layer 3 is a per-parse provider, not global state: the reader
            // can change key or model between loads and the next parse picks
            // it up without anything being reset.
            const aiProvider =
              stableAI && aiSettingsReady(stableAI)
                ? createAIProvider(stableAI, {
                    onReport: (r) => {
                      aiReport = r;
                    },
                  })
                : undefined;
            const transform = applyParserBackend(
              html,
              parserBackend,
              stableParserConfig,
            );
            label = transform.label;
            const resolvedParserConfig = {
              ...DEFAULT_CONFIG,
              ...transform.configOverride,
              // Widen layer 3's gate to anonymous div/span containers only
              // when there is a real provider to answer. With no provider the
              // parse is unchanged — see ParserConfig.aiFallbackIncludeWrappers.
              aiFallbackIncludeWrappers: aiProvider !== undefined,
            };
            ir = await parsePageToIR(
              transform.html,
              url!,
              aiProvider,
              resolvedParserConfig,
            );
          }

          scene = maybeFold(mapIRToScene(ir, DEFAULT_MAPPER_CONFIG));
          const plan = computeLayoutPlan(
            scene,
            deviceProfile,
            stableConfig,
            undefined,
            arrangement,
          );
          if (!cancelled)
            setResult({ scene, plan, error: null, backendLabel: label, aiReport });
          return;
        } else {
          // No input yet — an empty state, NOT an error. This is the window a
          // tab sits in between "the reader followed a link" and "the fetch
          // came back", and reporting it as an error made XRSceneRenderer
          // early-return its whole tree, unmounting the <Canvas> and killing
          // the WebGL context out from under any live XRSession. Leaving the
          // plan null instead renders an empty scene on the same canvas.
          if (!cancelled)
            setResult({
              scene: null,
              plan: null,
              error: null,
              backendLabel: "Custom Pipeline",
              aiReport: null,
            });
          return;
        }

        const plan = computeLayoutPlan(
          scene,
          deviceProfile,
          stableConfig,
          undefined,
          arrangement,
        );
        if (!cancelled)
          setResult({
            scene,
            plan,
            error: null,
            backendLabel: "Custom Pipeline",
            aiReport,
          });
      } catch (err) {
        if (!cancelled)
          setResult({
            scene: null,
            plan: null,
            error: err instanceof Error ? err.message : "Pipeline error.",
            backendLabel: "Custom Pipeline",
            aiReport,
          });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [
    html,
    sceneIn,
    url,
    deviceProfile,
    stableConfig,
    stableParserConfig,
    parserBackend,
    arrangement,
    stableAI,
  ]);

  return result;
}
