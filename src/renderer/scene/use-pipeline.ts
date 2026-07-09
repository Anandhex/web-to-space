/**
 * scene/use-pipeline.ts
 *
 * usePipeline() runs the HTML→IR→scene→layout pipeline (memoised) and returns
 * the LayoutPlan the renderer draws.
 */
import { useState, useEffect, useMemo } from "react";
import { parsePageToIR } from "../../ir/parser";
import { parsePageWithVIPS } from "../../ir/vips";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../../mapper/mapper";
import { computeLayoutPlan } from "../../layout/engine";
import { DEFAULT_CONFIG } from "../../ir/defaults";
import { applyParserBackend } from "../../ir/backends";
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
  templateOverride: import("../../layout/types").LayoutTemplate | undefined,
  arrangement: import("../../layout/types").Arrangement | undefined,
) {
  const [result, setResult] = useState({
    scene: null as SemanticScene | null,
    plan: null as LayoutPlan | null,
    error: null as string | null,
    backendLabel: "Custom Pipeline" as string,
  });

  const configHash = JSON.stringify(layoutConfig);
  const stableConfig = useMemo(() => layoutConfig, [configHash]);
  const parserConfigHash = JSON.stringify(parserConfig);
  const stableParserConfig = useMemo(() => parserConfig, [parserConfigHash]);

  useEffect(() => {
    let cancelled = false;

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
          });
        return;
      }

      try {
        let scene: SemanticScene;
        if (sceneIn) {
          scene = sceneIn;
        } else if (html) {
          let ir;
          let label: string;

          if (parserBackend === "vips") {
            ir = await parsePageWithVIPS(html, url!);
            label = "VIPS (Visual Blocks)";
          } else {
            const transform = applyParserBackend(
              html,
              parserBackend,
              stableParserConfig,
            );
            label = transform.label;
            const resolvedParserConfig = {
              ...DEFAULT_CONFIG,
              ...transform.configOverride,
            };
            ir = await parsePageToIR(
              transform.html,
              url!,
              undefined,
              resolvedParserConfig,
            );
          }

          scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
          const plan = computeLayoutPlan(
            scene,
            deviceProfile,
            templateOverride,
            stableConfig,
            undefined,
            arrangement,
          );
          if (!cancelled)
            setResult({ scene, plan, error: null, backendLabel: label });
          return;
        } else {
          if (!cancelled)
            setResult({
              scene: null,
              plan: null,
              error: "No html or scene provided.",
              backendLabel: "Custom Pipeline",
            });
          return;
        }

        const plan = computeLayoutPlan(
          scene,
          deviceProfile,
          templateOverride,
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
          });
      } catch (err) {
        if (!cancelled)
          setResult({
            scene: null,
            plan: null,
            error: err instanceof Error ? err.message : "Pipeline error.",
            backendLabel: "Custom Pipeline",
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
    templateOverride,
    arrangement,
  ]);

  return result;
}
