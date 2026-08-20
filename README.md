# Jarvis Voice Visualization

An embeddable, framework-neutral voice visualization driven by the remote audio track from an OpenAI Realtime WebRTC session. The repository is a pnpm workspace; the credential-minting BFF runs on Bun. Visualization code and ideas are sourced from [here](https://github.com/0xtigerclaw/audio_visualization_pretext).

## Packages

- `@jarvis-viz/core`: `VoiceViz`, audio features, state machine, canvas presets, streaming Pretext panel, and in-memory transcript store.
- `@jarvis-viz/react`: React lifecycle adapter and accessible, virtualized transcript view.
- `@jarvis-viz/wc`: Shadow DOM custom-element adapter.
- `@jarvis-viz/demo`: responsive simulation and live-session lab.
- `@jarvis-viz/server`: Bun BFF that mints short-lived OpenAI Realtime client secrets.

## Install and verify

```bash
pnpm install
pnpm verify
```

## Run the demo

```bash
pnpm dev
```

The simulation mode requires no credentials. For a live session, copy `server/.env.example` to `server/.env`, set `OPENAI_API_KEY`, and the `OPENAI_REALTIME_MODEL` then run:

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

Live evaluation lives at `http://localhost:5180/voice.html?mode=live`. The repeatable corpus and scoring rules are in `docs/realtime-reliability-eval.md`. Tracing is on by default. Set `OPENAI_REALTIME_TRACING=false` in `server/.env` and restart the BFF before creating a new session if you need it off. The setting cannot change on an already-running session.

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
viz.unmount();
```

The browser receives only a short-lived client secret. Never expose `OPENAI_API_KEY` to the demo or any consuming application.

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

The custom element renders inside Shadow DOM. Available themes are `cyan`, `amber`, `rose`,
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
