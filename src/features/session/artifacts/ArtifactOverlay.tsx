import { lazy, Suspense } from "react";
import { useFullscreenDoc } from "./viewer";

const ArtifactFull = lazy(() => import("./ArtifactPane").then((m) => ({ default: m.ArtifactFull })));

/** Mounted once by the app: the document shown full screen, if any (the viewer loads on first use). */
export function ArtifactOverlay() {
  const doc = useFullscreenDoc((s) => s.doc);
  if (!doc) return null;
  return (
    <Suspense fallback={null}>
      <ArtifactFull key={doc.agentKey} doc={doc} />
    </Suspense>
  );
}
