# @jarvis-viz/core

Framework-neutral realtime voice visualization. The public API is `VoiceViz`, its configuration and event types, preset names, themes, and transcript contracts.

```ts
import { VoiceViz } from "@jarvis-viz/core";

const viz = new VoiceViz({
  presets: ["ring", "particles", "hud"],
  theme: { paletteMode: "state", textMotion: "flow", density: 1.1 },
});
viz.mount(document.querySelector("#voice")!);
await viz.connect("/session");
```

Call `unmount()` when the host is removed. The core package never accepts or exposes a
long-lived provider API key.

`VoiceViz` forwards finalized provider function calls as the `toolcall` event. Custom
`RealtimeTransport` implementations must provide `submitToolResult`. Core keeps the
argument JSON opaque. The host application parses meaning and executes UI effects.
