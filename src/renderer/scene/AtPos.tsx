/**
 * scene/AtPos.tsx
 *
 * <AtPos> wraps a mesh in a positioned group that eases toward the entry's
 * position/rotation (so switching views morphs panels between arrangements)
 * and applies the nesting-depth Z stagger. Every leaf primitive uses it; the
 * mesh itself receives zeroedEntry() so it never double-applies the translation.
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { LayoutEntry } from "../../layout/types";
import { MORPH_RATE, MORPH_EPS } from "./config";
import { StackDepthContext, stackZ } from "./contexts";
import {
  usePanelCurve,
  curvePoint,
  CurvePlacedContext,
  useCurvePlaced,
} from "../primitives/curve";

export function AtPos({
  entry,
  children,
}: {
  entry: LayoutEntry;
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const targetPos = useRef(new THREE.Vector3());
  const targetRot = useRef(new THREE.Euler());
  const inited = useRef(false);
  const settled = useRef(false);
  const depth = React.useContext(StackDepthContext);
  const curve = usePanelCurve();
  const alreadyPlaced = useCurvePlaced();
  // Curve the position only if we're on the cylinder AND no ancestor already
  // tangent-placed this subtree (parent-relative nesting) — see CurvePlacedContext.
  const applyCurve = !!curve && !alreadyPlaced;

  // Derive the current target from props every render; a changed target
  // re-arms the easing loop. position.z carries the nesting-depth Z stagger so
  // a primitive sits in front of its container's backing instead of coplanar
  // with it (see StackDepthContext).
  //
  // Inside a curved panel every child is tangent-placed on the shared cylinder:
  // its flat panel-absolute position is mapped to an arc position (+z toward the
  // viewer) and a yaw that lays it flush on the surface. Since this is the
  // single placement chokepoint, one change here bends the entire subtree.
  const baseZ = entry.position.z + stackZ(depth);
  if (applyCurve && curve) {
    const { position: cp, yaw } = curvePoint(
      entry.position.x,
      entry.position.y,
      baseZ,
      curve.radius,
      curve.centerX,
    );
    targetPos.current.set(cp[0], cp[1], cp[2]);
    targetRot.current.set(
      entry.rotation.x,
      entry.rotation.y + yaw,
      entry.rotation.z,
    );
  } else {
    targetPos.current.set(entry.position.x, entry.position.y, baseZ);
    targetRot.current.set(entry.rotation.x, entry.rotation.y, entry.rotation.z);
  }
  settled.current = false;

  React.useLayoutEffect(() => {
    const g = ref.current;
    if (g && !inited.current) {
      g.position.copy(targetPos.current);
      g.rotation.copy(targetRot.current);
      inited.current = true;
      settled.current = true;
    }
  });

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || !inited.current || settled.current) return;
    const a = 1 - Math.exp(-MORPH_RATE * Math.min(dt, 0.1));

    const p = g.position;
    const tp = targetPos.current;
    const dpx = tp.x - p.x;
    const dpy = tp.y - p.y;
    const dpz = tp.z - p.z;
    const posSettled =
      Math.abs(dpx) + Math.abs(dpy) + Math.abs(dpz) < MORPH_EPS;
    if (posSettled) p.copy(tp);
    else {
      p.x += dpx * a;
      p.y += dpy * a;
      p.z += dpz * a;
    }

    const r = g.rotation;
    const tr = targetRot.current;
    const drx = tr.x - r.x;
    const dry = tr.y - r.y;
    const drz = tr.z - r.z;
    const rotSettled =
      Math.abs(drx) + Math.abs(dry) + Math.abs(drz) < MORPH_EPS;
    if (rotSettled) r.set(tr.x, tr.y, tr.z);
    else {
      r.x += drx * a;
      r.y += dry * a;
      r.z += drz * a;
    }

    settled.current = posSettled && rotSettled;
  });

  // Once we've tangent-placed this group, descendants (parent-relative nested
  // AtPos) must translate rigidly rather than re-curve their position.
  return (
    <group ref={ref}>
      {applyCurve ? (
        <CurvePlacedContext.Provider value={true}>
          {children}
        </CurvePlacedContext.Provider>
      ) : (
        children
      )}
    </group>
  );
}
