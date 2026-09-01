/**
 * scene/study-gate.tsx — the in-headset stop between trials.
 *
 * A study session runs trial after trial (`docs/study-plan.md`), but the
 * post-trial questionnaire is answered on paper, headset off. `StudyGatePanel`
 * is what the reader sees the instant a trial's last task/hop lands: a
 * head-anchored panel, centred rather than in a corner like the minimap or
 * the quest card, because for the seconds it is up it IS the scene — it
 * tells them to take the headset off and fill in the sheet, and gives them
 * exactly one thing to click, Start, for when they put it back on. On the
 * last trial there is no button at all: the session is over.
 *
 * Owns no state. `gate` and `onStart` come from App.tsx, the one place that
 * holds the full trial list and can load the next one — this component only
 * has to be visible and clickable inside an active XR session, the same way
 * the minimap and the quest card already are (see `useHeadAnchor`).
 */
import React from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";

import { useTheme } from "../theme";
import { useHeadAnchor } from "./head-anchor";
import { FontContext } from "./contexts";
import { HIT_TARGET_MATERIAL } from "../primitives/constants";

/** Panel size, metres. Deliberately larger than the corner overlays — this
 *  is a modal stop, not an ambient status card. */
const W = 0.56;
const H = 0.34;
const BTN_W = 0.28;
const BTN_H = 0.06;

export type StudyGatePhase = "none" | "complete" | "finished";

export function StudyGatePanel({
  gate,
  onStart,
}: {
  gate: StudyGatePhase;
  onStart: () => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const group = React.useRef<THREE.Group>(null);
  const [hover, setHover] = React.useState(false);
  const visible = gate !== "none";
  useHeadAnchor(group, 0, 0, visible);

  // A gate that comes back (next trial's completion) re-arms its own hover
  // state rather than carrying a stale highlight from the last one.
  React.useEffect(() => {
    if (!visible) setHover(false);
  }, [visible]);

  if (!visible) return null;

  const finished = gate === "finished";
  const title = finished ? "Thank you" : "Trial complete";
  const body = finished
    ? "That was the last trial. Thank you for taking part in this study — you can remove the headset now."
    : "Remove the headset and fill in this trial's questionnaire. Put it back on and press Start when you're ready for the next trial.";

  return (
    <group ref={group} renderOrder={30}>
      <mesh>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial
          color={theme.navBg}
          transparent
          opacity={0.97}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0, -0.001]}>
        <planeGeometry args={[W + 0.008, H + 0.008]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.7}
          depthWrite={false}
        />
      </mesh>

      <Text
        font={fontType}
        anchorX="center"
        anchorY="top"
        position={[0, H / 2 - 0.03, 0.002]}
        fontSize={0.026}
        color={theme.headingCol}
      >
        {title}
      </Text>

      <Text
        font={fontType}
        anchorX="center"
        anchorY="top"
        position={[0, H / 2 - 0.078, 0.002]}
        fontSize={0.015}
        color={theme.bodyCol}
        maxWidth={W - 0.07}
        lineHeight={1.4}
        textAlign="center"
      >
        {body}
      </Text>

      {!finished && (
        <group position={[0, -H / 2 + 0.055, 0.002]}>
          <mesh>
            <planeGeometry args={[BTN_W, BTN_H]} />
            <meshBasicMaterial
              color={theme.accentCol}
              transparent
              opacity={hover ? 1 : 0.88}
              depthWrite={false}
            />
          </mesh>
          <Text
            font={fontType}
            anchorX="center"
            anchorY="middle"
            position={[0, 0.001, 0.001]}
            fontSize={0.017}
            color="#ffffff"
          >
            Start next trial
          </Text>
          {/* Oversized invisible hit target, same pattern as the minimap's
              node glyphs — the visible button is smaller than what is
              comfortable to aim a controller ray at. */}
          <mesh
            position={[0, 0, 0.003]}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(true);
            }}
            onPointerOut={() => setHover(false)}
            onClick={(e) => {
              e.stopPropagation();
              onStart();
            }}
          >
            <planeGeometry args={[BTN_W + 0.03, BTN_H + 0.03]} />
            <primitive
              object={HIT_TARGET_MATERIAL}
              attach="material"
              dispose={null}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}
