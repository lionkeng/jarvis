import { useLayoutEffect, useRef } from "react";
import type { VoiceRegistry } from "./registry.js";
import type { VoiceCapability } from "./types.js";

export function useVoiceCapability(registry: VoiceRegistry, capability: VoiceCapability): void {
  const latest = useRef(capability);
  latest.current = capability;
  const id = capability.describe().control.id;
  useLayoutEffect(() => {
    const registered: VoiceCapability = {
      describe: () => latest.current.describe(),
      execute: (command, signal) => latest.current.execute(command, signal),
    };
    return registry.register(registered);
  }, [registry, id]);
}
