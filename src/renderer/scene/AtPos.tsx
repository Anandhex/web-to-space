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

  // Derive the current target from props every render; a changed target
  // re-arms the easing loop. position.z carries the nesting-depth Z stagger so
  // a primitive sits in front of its container's backing instead of coplanar
  // with it (see StackDepthContext).
  targetPos.current.set(
    entry.position.x,
    entry.position.y,
    entry.position.z + stackZ(depth),
  );
  targetRot.current.set(entry.rotation.x, entry.rotation.y, entry.rotation.z);
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

  return <group ref={ref}>{children}</group>;
}
