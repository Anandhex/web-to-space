import { useMemo } from "react";
import { Plane, Vector3 } from "three";
import type { LayoutEntry } from "../layout/engine";

/**
 * Returns four clipping planes that form a rectangular viewport
 * of width × height at the panel's world position.
 * Children rendered inside the group will be clipped to this rect.
 */
function usePanelClipPlanes(entry: LayoutEntry): Plane[] {
  return useMemo(() => {
    const { x, y } = entry.position;
    const { width, height } = entry.size;
    return [
      new Plane(new Vector3(1, 0, 0), -x), // left
      new Plane(new Vector3(-1, 0, 0), x + width), // right
      new Plane(new Vector3(0, 1, 0), -(y - height)), // bottom
      new Plane(new Vector3(0, -1, 0), y), // top
    ];
  }, [entry.position.x, entry.position.y, entry.size.width, entry.size.height]);
}

export { usePanelClipPlanes };
