import { useEffect, useState } from "react";
import { core } from "@/core";
import type { AppInfo } from "@/core/gen";

let cached: Promise<AppInfo> | null = null;

/** `app.info` (version, platform, capabilities), fetched once per app run. Undefined until loaded. */
export function useAppInfo(): AppInfo | undefined {
  const [info, setInfo] = useState<AppInfo>();
  useEffect(() => {
    let live = true;
    cached ??= core.app("app.info", {});
    cached.then(
      (i) => live && setInfo(i),
      () => {
        cached = null;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return info;
}
