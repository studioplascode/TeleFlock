import type { DemoEngine } from "../demo/engine";
import type { CoreTransport } from "./types";

/** In-process simulator as a transport: app and host methods both go to the demo engine. */
export function createDemoTransport(engine: DemoEngine): CoreTransport {
  return {
    kind: "demo",
    call: (hostId, method, params) =>
      hostId === null ? engine.callApp(method, params) : engine.callHost(hostId, method, params),
    termInput: (hostId, termId, data) => engine.termInput(hostId, termId, data),
    subscribe: (onEvent) => engine.subscribe(onEvent),
  };
}
