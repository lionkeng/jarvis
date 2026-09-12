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
`RealtimeTransport` implementations must provide `submitToolResult` and must emit
`disconnected` when their `disconnect()` completes, because `VoiceViz.disconnect()` waits
for that event before releasing audio and state. Core keeps the argument JSON opaque. The
host application parses meaning and executes UI effects. `providererror` and
`backendfailed` report recoverable provider and backend failures without ending the
session; `error` means the session is ending.

The default transport uses GPT Live-1. `/session` accepts JSON with an SDP offer and optional `responseTiming` and `speechRate` preferences. It returns `{ session: { id }, transport: { type: "webrtc", sdp } }`. Preferences guide conversation prompts. They are not exact VAD or playback controls.

The same endpoint must support `GET` with `Accept: text/event-stream`. Send `event: ready\ndata: {}\n\n` initially, then keep the stream alive with data or SSE comments every five seconds. The transport opens this stream before microphone capture. Stream termination or 15 seconds without data immediately stops the microphone and peer connection, attempts provider closure, and reports unconfirmed final usage. It does not automatically reconnect.

Await `viz.disconnect()` before unmounting to drain `session.closed` and collect the final `usage` event. The microphone stops as soon as the close starts. Usage values are cumulative voice seconds, not increments. Live caption messages retain timed `fragments`; user and assistant rows can overlap, and a Live disconnect completes the last row rather than marking it interrupted. Existing `RealtimeTransport` type names remain available for custom transports and simulation.
