# Jarvis Voice Visualization

An embeddable, framework-neutral voice visualization driven by the remote audio track from a GPT Live-1 WebRTC session. The repository is a pnpm workspace; the session broker runs on Bun. Visualization code and ideas are sourced from [here](https://github.com/0xtigerclaw/audio_visualization_pretext).

## Packages

- `@jarvis-viz/core`: `VoiceViz`, audio features, state machine, canvas presets, streaming Pretext panel, and in-memory transcript store.
- `@jarvis-viz/react`: React lifecycle adapter and accessible, virtualized transcript view.
- `@jarvis-viz/wc`: Shadow DOM custom-element adapter.
- `@jarvis-viz/demo`: responsive simulation and live-session lab.
- `@jarvis-viz/server`: Bun BFF that exchanges SDP offers for GPT Live-1 sessions.

## Install and verify

```bash
pnpm install
pnpm verify
```

## Run the demo

```bash
pnpm dev
```

The simulation mode requires no credentials. For a live session, copy `server/.env.example` to `server/.env`, set `OPENAI_API_KEY`, then run:

```bash
pnpm dev:server
```

OR, to run both demo and the server,
```bash
pnpm dev:all
```

Open `http://localhost:5180/`. Select **OpenAI live**, and connect the primary host to `http://localhost:3010/session`. Vite fails if port 5180 is already taken so the page origin stays on the allowlist.

## Voice-first demo

Open `/voice.html#/dashboard`. Simulation mode needs no credentials. Live mode uses the same Bun session endpoint as the visualization lab.

Spoken UI requests become one `perform_ui_actions` call. `VoiceViz` emits a `toolcall` event. A demo-only XState actor validates the call, runs a registered capability, and returns one result through `submitToolResult`. Ordinary questions stay in conversation and do not change the page.

The voice model defaults to `gpt-live-1`. UI actions run through Responses delegation with `gpt-5.6-luna`, configured independently by `OPENAI_LIVE_BACKEND_MODEL`. `MAX_OUTPUT_TOKENS` caps the backend output. Voice timing and speed are prompt preferences, so exact timing and playback speed are not guaranteed. Live manages context automatically; the old `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_TRACING`, and `CONTEXT_TOKEN_LIMIT` settings no longer apply.

Live evaluation instructions are in `docs/realtime-reliability-eval.md`. Open the voice demo, select **OpenAI live**, and connect. Captions preserve each speaker's fragments and timestamps independently. Speaking over the assistant does not cancel a pending UI action.

`await viz.disconnect()` stops the microphone, sends `session.close`, waits up to 15 seconds for `session.closed`, then releases the WebRTC connection. Provider errors and failed backend responses arrive as `providererror` and `backendfailed` events and leave the session open. An `error` event means the session is ending. Subscribe to `viz.on("usage", ...)` for cumulative voice seconds and final usage. The separate `backendusage` event reports delegated Responses token totals with their response and delegation IDs. A timeout or lost connection reports unconfirmed final voice usage. `unmount()` starts the same cleanup without waiting; disconnect first to collect final usage before removing the host.

The browser also keeps a lifetime stream open with `GET /session` before creating a voice session. Stopping the Bun server, including with Ctrl+C, ends that stream. The browser then requests provider closure and immediately releases its microphone and WebRTC connection. A stalled stream is detected after 15 seconds without data. Server loss reports unconfirmed final usage and requires an explicit reconnect after restart. The stream needs an allowed Origin, and each origin may hold at most `LIFETIME_STREAMS_PER_ORIGIN` streams (default 4). Browsers omit the Origin header on same-origin GET requests, so a deployment that serves the page and the BFF from one origin needs a second acceptance rule before the stream will open. Custom session brokers must support this stream as well as the SDP POST.

`pnpm check:server-lifetime` tests real server termination with SIGINT, SIGTERM, and SIGKILL. It uses the built core package and simulated provider/media resources, so it needs no API key or microphone. It also runs in `pnpm verify`.

The integration follows the [GPT-Live guide](https://developers.openai.com/api/docs/guides/live), [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), and [delegation contract](https://developers.openai.com/api/docs/guides/live-delegation).

Supported commands are navigation, library selection, the details drawer, named-region scrolling, dashboard search focus, article bookmark activation, and theme selection. The model cannot choose CSS selectors, pointer coordinates, JavaScript, or URLs. XState is a demo dependency. It is not part of `@jarvis-viz/core`.

## Core usage

```ts
import { VoiceViz } from "@jarvis-viz/core";

const viz = new VoiceViz({
  presets: ["ring", "particles", "hud"],
  panelPlacement: "auto",
  theme: "cyan",
});
viz.mount(document.querySelector("#voice")!);

await viz.connect("https://your-bff.example/session");

// Later
await viz.disconnect();
viz.unmount();
```

The browser sends its SDP offer to the BFF and receives only a session ID and SDP answer. Never expose `OPENAI_API_KEY` to the demo or any consuming application.

## React usage

```tsx
import { useState } from "react";
import { TranscriptView, VoiceVizCanvas } from "@jarvis-viz/react";
import type { VoiceViz } from "@jarvis-viz/core";

export function VoiceAssistant() {
  const [viz, setViz] = useState<VoiceViz | null>(null);
  return (
    <>
      <VoiceVizCanvas
        autoConnect
        tokenEndpoint="https://your-bff.example/session"
        options={{ presets: ["ring", "hud"], theme: "cyan" }}
        onReady={setViz}
        style={{ height: 480 }}
      />
      {viz ? <TranscriptView store={viz.transcript} /> : null}
    </>
  );
}
```

## Web component usage

```html
<script type="module">
  import { defineVoiceVizElement } from "@jarvis-viz/wc";
  defineVoiceVizElement();
</script>

<jarvis-voice-viz
  style="display:block;height:480px"
  presets="ring,particles,hud"
  theme="ultraviolet"
  token-endpoint="https://your-bff.example/session"
  auto-connect
></jarvis-voice-viz>
```

The existing React `tokenEndpoint` prop and web component `token-endpoint` attribute now point to the Live SDP broker. Their names remain compatible with existing hosts. The custom element renders inside Shadow DOM. Available themes are `cyan`, `amber`, `rose`,
`spectrum`, `coast`, `ultraviolet`, and `magenta`.

During local development, `/embed.html` is a reproducible web-component host page with
deliberately hostile global canvas and typography CSS. The internal canvas remains isolated by
the component's Shadow DOM.

## Bun BFF (Backend For Frontend)

The BFF is deliberately simple for demo purposes. It has no application auth, and a small in-memory footprint for session rate-limit and session-budget state. Copy `server/.env.example` to `server/.env`,
set the API key and exact allowed origins, then run `pnpm dev:server`. Production builds use:

```bash
pnpm --filter @jarvis-viz/server build
pnpm --filter @jarvis-viz/server start
```

Install the Bun version pinned in `.bun-version`. pnpm remains the only dependency installer;
do not run `bun install` or commit a Bun lockfile.
