import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { DesignProvider, Spinner, TitleBar } from "@/design";
import { navigate, useRoutePath } from "./router";

/** Route table. Feature agents add their screens here. */
const routes: Record<string, ComponentType> = {
  "/design": lazy(() => import("./routes/design/DesignGallery")),
};

/** Where "/" and unknown paths go. */
const DEFAULT_ROUTE = "/design";

export function App() {
  const path = useRoutePath();
  const Page = routes[path];

  useEffect(() => {
    if (!Page) navigate(DEFAULT_ROUTE, { replace: true });
  }, [Page]);

  return (
    <DesignProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <main className="relative min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center">
                <Spinner size={22} />
              </div>
            }
          >
            {Page && <Page />}
          </Suspense>
        </main>
      </div>
    </DesignProvider>
  );
}
