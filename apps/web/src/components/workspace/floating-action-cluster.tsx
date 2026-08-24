import { BottomIsland } from "./bottom-island";
import { useDock } from "./dock-context";

/** Calendar actions stay centered over the canvas. The assistant is mounted at
 * workspace level because it is a full drawer rather than part of this dock. */
export function FloatingActionCluster() {
  const { view } = useDock();
  if (!view) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <div className="pointer-events-none absolute right-0 bottom-3 left-[84px] flex justify-center">
        <BottomIsland />
      </div>
    </div>
  );
}
