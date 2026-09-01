/**
 * scene/task-hud.tsx — the quest card, and the study-condition context it
 * shares with `navigate()`.
 *
 * "3 / 4 — Find the entry for the Cape Verde Islands", top-right, head-
 * anchored the same way the minimap is (`useHeadAnchor`), mirrored:
 * minimap sits at (-0.33, -0.24), this sits at (+0.33, +0.24). Diagonally
 * opposite so the two corner overlays never collide, and inheriting the
 * follow's `SNAP_DIST` guard so a teleport in rooms cannot drag the card
 * through a wall.
 *
 * `StudyTaskProvider` owns the within-trial task-index state and is the one
 * place Block A's clicks (recorded from `navigate()`, deep inside the scene
 * graph) and Block B's arrivals (watched here, from the `url` XRSceneRenderer
 * already carries) both land — so the same counter that advances the card
 * is the one `navigate()`'s `#task/` hook advances. `<TaskHud>` only reads
 * that state; it does not own it, because App.tsx's `traverse()` needs the
 * study condition too (for `hop_attempt`/`hop_landed`) and lives outside the
 * Canvas this provider is mounted inside — seeing this module's exported
 * `study` prop is how it gets it, and `study/logger.ts`'s module-level
 * context is how the two sides agree on one participant/block/trial without
 * threading a callback across that boundary.
 *
 * The one thing this module DOES thread a callback for is `onTrialComplete`
 * — App.tsx is the only place that knows whether there is a next trial or
 * this was the last one, so the provider just announces "done" and leaves
 * that decision, and showing `scene/study-gate.tsx`'s panel, to the caller.
 */
import React from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";

import { useTheme } from "../theme";
import { useHeadAnchor } from "./head-anchor";
import { FontContext } from "./contexts";
import { logStudyEvent } from "../../study/logger";
import type { StudyCondition } from "../../study/types";

// ── Context: the seam navigate() and the card share ───────────────────────

export interface StudyTaskApi {
  study: StudyCondition | null;
  /** Which task (Block A) or hop (Block B) the reader is currently on. */
  taskIndex: number;
  /** `navigate()` calls this when a `#task/<id>` fragment is clicked. */
  onTaskClick: (id: string) => void;
}

const NOOP_API: StudyTaskApi = {
  study: null,
  taskIndex: 0,
  onTaskClick: () => {},
};

const StudyTaskContext = React.createContext<StudyTaskApi>(NOOP_API);

export function useStudyTask(): StudyTaskApi {
  return React.useContext(StudyTaskContext);
}

/**
 * Owns the task-index counter for one trial and reports every quest event
 * through `study/logger.ts`. A no-op (renders `children` unchanged, context
 * stays at its default) whenever `study` is null — an ordinary reading
 * session never touches this.
 */
export function StudyTaskProvider({
  study,
  url,
  onTrialComplete,
  children,
}: {
  study: StudyCondition | null;
  /** The document currently loaded in this tab — advances Block B's hops. */
  url: string;
  /**
   * Fired once, right after this trial logs its own `trial_end` with
   * `status: "complete"` — never on an operator abort, which logs the same
   * event from the runner instead and does not go through here. Lets the
   * host (App.tsx) show the in-headset gate and line up the next trial,
   * without this provider having to know there IS a "next" — see
   * scene/study-gate.tsx.
   */
  onTrialComplete?: () => void;
  children: React.ReactNode;
}) {
  const [taskIndex, setTaskIndex] = React.useState(0);
  const shownAt = React.useRef(0);
  const prevUrl = React.useRef(url);
  // Latest callback without making it an effect dependency — the effects
  // below key off `url`/`taskIndex` changing, not off the host re-rendering
  // with a fresh function identity.
  const onTrialCompleteRef = React.useRef(onTrialComplete);
  onTrialCompleteRef.current = onTrialComplete;
  // A study session runs against `npm run dev`, which mounts under
  // React.StrictMode — its dev-only double-invoke fires this effect twice in
  // immediate succession on the same fiber, so a ref (which survives the
  // simulated remount) is what stops `trial_start`/`task_shown` from being
  // logged twice per trial in every real session's JSONL.
  const announcedTrial = React.useRef<string | null>(null);

  // A new trial always starts at its first task/hop, whatever the last one
  // ended on.
  React.useEffect(() => {
    setTaskIndex(0);
    shownAt.current = performance.now();
    prevUrl.current = url;
    if (!study) return;
    const key = `${study.participant}:${study.block}:${study.trial}`;
    if (announcedTrial.current === key) return;
    announcedTrial.current = key;
    logStudyEvent("trial_start", { startUrl: study.startUrl });
    if (study.block === "A") {
      const first = study.tasks[0];
      if (first) logStudyEvent("task_shown", { targetId: first.id, index: 0 });
    } else {
      const first = study.route[0];
      if (first) logStudyEvent("task_shown", { to: first.toUrl, index: 0 });
    }
    // Only a new trial resets the chain — re-running this on every `url`
    // change would re-show task 1 on every intermediate hop of a route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.participant, study?.block, study?.trial]);

  // Block B: the reader's location is the only signal that a hop landed —
  // there is no click to hook, since doors, corridors, strips and the
  // in-place `plain` traversal all commit through the same `url` prop.
  React.useEffect(() => {
    if (!study || study.block !== "B") return;
    if (url === prevUrl.current) return;
    prevUrl.current = url;
    const target = study.route[taskIndex];
    if (!target) return;
    const elapsedMs = performance.now() - shownAt.current;
    if (url === target.toUrl) {
      logStudyEvent("hop_landed", { to: url, index: taskIndex, ms: elapsedMs });
      const next = taskIndex + 1;
      setTaskIndex(next);
      shownAt.current = performance.now();
      const nextHop = study.route[next];
      if (nextHop) {
        logStudyEvent("task_shown", { to: nextHop.toUrl, index: next });
      } else {
        logStudyEvent("route_complete", { hops: study.route.length });
        logStudyEvent("trial_end", { status: "complete" });
        onTrialCompleteRef.current?.();
      }
    } else {
      // A wrong page. The card stays put — this is not the hop that was
      // asked for, so the counter does not advance and the reader has to
      // find their way from wherever they landed.
      logStudyEvent("wrong_turn", {
        to: url,
        expected: target.toUrl,
        index: taskIndex,
      });
    }
  }, [url, study, taskIndex]);

  const onTaskClick = React.useCallback(
    (id: string) => {
      if (!study || study.block !== "A") return;
      const task = study.tasks[taskIndex];
      if (!task) return;
      const elapsedMs = performance.now() - shownAt.current;
      if (id === task.id) {
        logStudyEvent("task_hit", { targetId: id, index: taskIndex, ms: elapsedMs });
        const next = taskIndex + 1;
        setTaskIndex(next);
        shownAt.current = performance.now();
        const nextTask = study.tasks[next];
        if (nextTask) {
          logStudyEvent("task_shown", { targetId: nextTask.id, index: next });
        } else {
          logStudyEvent("trial_end", { status: "complete" });
          onTrialCompleteRef.current?.();
        }
      } else {
        logStudyEvent("task_miss", { decoyId: id, index: taskIndex, ms: elapsedMs });
      }
    },
    [study, taskIndex],
  );

  const api = React.useMemo<StudyTaskApi>(
    () => ({ study, taskIndex, onTaskClick }),
    [study, taskIndex, onTaskClick],
  );

  return (
    <StudyTaskContext.Provider value={api}>{children}</StudyTaskContext.Provider>
  );
}

// ── The card itself ────────────────────────────────────────────────────

/** Panel size, metres — the minimap's own. */
const W = 0.3;
const H = 0.09;
/** Top-right: the minimap's corner, mirrored on both axes. */
const OFF_X = 0.33;
const OFF_Y = 0.24;

function taskLabel(study: StudyCondition, taskIndex: number): string | null {
  if (study.block === "A") {
    const total = study.tasks.length;
    if (taskIndex >= total) return "All four found";
    const task = study.tasks[taskIndex];
    return task ? `${taskIndex + 1} / ${total} — Find ${task.label}` : null;
  }
  const total = study.route.length;
  if (taskIndex >= total) return "Route complete";
  const hop = study.route[taskIndex];
  return hop ? `${taskIndex + 1} / ${total} — Go to "${hop.toLabel}"` : null;
}

export function TaskHud() {
  const { study, taskIndex } = useStudyTask();
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const group = React.useRef<THREE.Group>(null);
  const visible = Boolean(study);
  useHeadAnchor(group, OFF_X, OFF_Y, visible);

  if (!study) return null;
  const label = taskLabel(study, taskIndex);
  if (!label) return null;

  const total = study.block === "A" ? study.tasks.length : study.route.length;
  const progress = total > 0 ? Math.min(taskIndex, total) / total : 0;

  return (
    <group ref={group} renderOrder={21}>
      <mesh>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial
          color={theme.navBg}
          transparent
          opacity={0.92}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0, -0.001]}>
        <planeGeometry args={[W + 0.005, H + 0.005]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>

      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[-W / 2 + 0.014, H / 2 - 0.012, 0.002]}
        fontSize={0.016}
        color={theme.headingCol}
        maxWidth={W - 0.028}
        lineHeight={1.3}
      >
        {label}
      </Text>

      {/* Progress row: a quiet track filling left to right. */}
      <group position={[0, -H / 2 + 0.014, 0.002]}>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[W - 0.028, 0.0016]} />
          <meshBasicMaterial
            color={theme.mutedTextCol}
            transparent
            opacity={0.4}
            depthWrite={false}
          />
        </mesh>
        {progress > 0 && (
          <mesh
            position={[-(W - 0.028) / 2 + ((W - 0.028) * progress) / 2, 0, 0.0005]}
          >
            <planeGeometry args={[(W - 0.028) * progress, 0.0016]} />
            <meshBasicMaterial
              color={theme.headingCol}
              transparent
              opacity={0.9}
              depthWrite={false}
            />
          </mesh>
        )}
      </group>
    </group>
  );
}
