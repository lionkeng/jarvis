# Jarvis Voice Visualization

An embeddable, framework-neutral voice visualization driven by the agent audio track of a duplex voice session. The browser talks to OpenAI GPT-Live-1 over WebRTC or to Gemini 3.8 Live over a WebSocket. The repository is a pnpm workspace; the session broker runs on Bun. Visualization code and ideas are sourced from [here](https://github.com/0xtigerclaw/audio_visualization_pretext).

## Packages

- `@jarvis-viz/core`: `VoiceViz`, audio features, state machine, canvas presets, streaming Pretext panel, and in-memory transcript store.
- `@jarvis-viz/react`: React lifecycle adapter and accessible, virtualized transcript view.
- `@jarvis-viz/wc`: Shadow DOM custom-element adapter.
- `@jarvis-viz/demo`: responsive simulation and live-session lab.
- `@jarvis-viz/server`: Bun BFF that issues GPT Live-1 sessions and Gemini 3.8 Live tokens.

## Install and verify

```bash
pnpm install
pnpm verify
```

## Run the demo

```bash
pnpm dev
```

The simulation mode requires no credentials. For a live session, copy `server/.env.example` to `server/.env`, then set `OPENAI_API_KEY`, `GEMINI_API_KEY`, or both. Each key is optional on its own. The BFF needs at least one of them to start. Then run:

```bash
pnpm dev:server
```

OR, to run both demo and the server,
```bash
pnpm dev:all
```

Open `http://localhost:5180/`. Select **OpenAI** or **Gemini**, and connect the primary host to `http://localhost:3010/session`. Vite fails if port 5180 is already taken so the page origin stays on the allowlist.

## Voice-first demo

Open `/voice.html#/dashboard`. The demo offers three sources: **Simulation**, **OpenAI**, and **Gemini**. Simulation needs no credentials. Both live sources use the same Bun session endpoint as the visualization lab.

Spoken UI requests become one `perform_ui_actions` call. `VoiceViz` emits a `toolcall` event. A demo-only XState actor validates the call, runs a registered capability, and returns one result through `submitToolResult`. Ordinary questions stay in conversation and do not change the page.

The OpenAI voice model defaults to `gpt-live-1`. Its UI actions run through Responses delegation with `gpt-5.6-luna`. Gemini has no delegation protocol and no backend model. Gemini reasoning comes from the Live model id, either `gemini-3.8-live` or `gemini-3.8-live-extended-thinking`. Voice timing and speed are prompt preferences, so exact timing and playback speed are not guaranteed.

Live evaluation instructions are in `docs/realtime-reliability-eval.md`. Open the voice demo, select **OpenAI** or **Gemini**, and connect. OpenAI captions preserve each speaker's fragments and timestamps independently. Gemini transcripts carry no timestamps. Its text arrives as audio-paced deltas, and the channel emits no timed caption rows. On OpenAI, speaking over the assistant does not cancel a pending UI action. On Gemini, Google discards its pending function calls when it reports an interruption, and a late result for a discarded call is ignored.

`await viz.disconnect()` stops the microphone. Each protocol then runs its own close discipline. OpenAI sends `session.close`, waits up to 15 seconds for `session.closed`, then releases the WebRTC connection. Gemini stops capture and closes the WebSocket, with a 2 second fallback and no wait for a provider message. Losing the lifetime lease ends either protocol at once.

Provider errors and failed backend responses arrive as `providererror` and `backendfailed` events and leave the session open. An `error` event means the session is ending. Subscribe to `viz.on("usage", ...)` for cumulative voice seconds and final usage. The separate `backendusage` event reports delegated Responses token totals with their response and delegation IDs. A timeout or lost connection reports unconfirmed final voice usage. `usage`, `backendusage`, and `backendfailed` are OpenAI events. Gemini emits none of them and reports no usage seconds. `unmount()` starts the same cleanup without waiting; disconnect first to collect final usage before removing the host.

The browser also keeps a lifetime stream open with `GET /session` before creating a voice session. Stopping the Bun server, including with Ctrl+C, ends that stream. The browser then requests provider closure and immediately releases its microphone and WebRTC connection. A stalled stream is detected after 15 seconds without data. Server loss reports unconfirmed final usage and requires an explicit reconnect after restart. The stream needs an allowed Origin, and each origin may hold at most `LIFETIME_STREAMS_PER_ORIGIN` streams (default 4). Browsers omit the Origin header on same-origin GET requests, so a deployment that serves the page and the BFF from one origin needs a second acceptance rule before the stream will open. Custom session brokers must support this stream as well as the POST. The origin guard, the rate limit, the per-origin session budget, and the lifetime-stream cap apply to both protocols equally.

`pnpm check:server-lifetime` tests real server termination with SIGINT, SIGTERM, and SIGKILL. It uses the built core package and simulated provider/media resources, so it needs no API key or microphone. It runs in Node, which has no Web Audio, so it covers the OpenAI path only. It also runs in `pnpm verify`.

The integration follows the [GPT-Live guide](https://developers.openai.com/api/docs/guides/live), [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), and [delegation contract](https://developers.openai.com/api/docs/guides/live-delegation).

Supported commands are navigation, library selection, the details drawer, named-region scrolling, dashboard search focus, article bookmark activation, and theme selection. The model cannot choose CSS selectors, pointer coordinates, JavaScript, or URLs. XState is a demo dependency. It is not part of `@jarvis-viz/core`.

## Session broker contract

The browser opens `GET /session` before it creates a voice session. That stream is the lifetime lease. Its `ready` event now lists the broker's protocol ids, for example `{"protocols":["openai-live","gemini-live"]}`. An older broker that sends `{}` still means `openai-live`.

The browser then sends `POST /session` with a flat JSON body. The body carries `responseTiming`, `speechRate`, and an optional `protocol`. A body with `sdp` and no `protocol` is still an OpenAI request, so existing hosts keep working.

The OpenAI grant keeps today's shape, `{ session, transport }`, with the session ID and the SDP answer. The Gemini grant is `{ kind: "websocket-token", endpoint, token, setup, expiresAt }`.

OpenAI posts once per session. Gemini posts again on every reconnect, because its token is single-use.

## Choosing a live transport

`createLiveTransport` pins one protocol.

```ts
import { createLiveTransport, VoiceViz } from "@jarvis-viz/core";

const viz = new VoiceViz({
  transport: createLiveTransport({ protocol: "gemini-live" }),
});
await viz.connect("https://your-bff.example/session");
```

`protocol` is `"openai-live"` or `"gemini-live"`. React accepts the same object as `options.transport`. The web component accepts it as the `transport` JavaScript property. There is no `live-provider` attribute.

A host that passes no transport gets the default. The default reads the broker's protocol list from the lease and runs the first protocol that can run in that browser. A pinned protocol that the broker does not offer fails the connection.

## Gemini live path

The BFF mints one single-use ephemeral token per Gemini connection. The token expires after 30 minutes and has 1 minute to start a session. Google locks the model and every setup field the token's field mask names. The browser cannot change the tools, the system instruction, the voice, or transcription. `sessionResumption` is the one setup field the mask leaves open, which is how the browser carries its resumption handle into a new connection.

The browser then opens the WebSocket to Google itself. The BFF never sees conversation audio, transcripts, or tool calls, and `GEMINI_API_KEY` stays in the Bun process.

Audio is 16-bit PCM. Capture runs at 16 kHz and playback at 24 kHz. A browser that refuses a 16 kHz capture context falls back to the device rate, and each audio frame states the rate it carries. Agent audio plays into a `MediaStream` that `VoiceViz` monitors, so it never reaches the speakers a second time. When Google reports an interruption, the channel clears queued playback at once.

Google closes each connection after about 10 minutes. Google's documentation describes a `goAway` message before the close. In live runs the connection closed with code 1011 and no `goAway`. The channel reconnects on either signal.

A reconnect asks the broker for a fresh grant, then dials with the new token and the latest resumption handle. A single-use token cannot open a second connection, so every reconnect is another `POST /session`. The reconnect keeps the same agent audio stream and emits no `disconnected` and no second `connected`. It drops pending tool calls.

That second POST passes the origin guard, the rate limit, and the per-origin session budget, and spends one slot of each. A long Gemini session therefore draws down the session budget as it runs. Size `SESSION_BUDGET_REQUESTS` for roughly one reconnect every 10 minutes per live session.

The channel fails closed instead of reconnecting when:

- no resumable handle exists
- the close code is 1007 or 1008
- the new grant fails, including a 429 from the broker
- the dial fails
- a reconnected socket closes within 10 seconds of its own setup

Each grant expires 30 minutes after the BFF mints it, and the expiry timer follows the newest grant. A reconnect therefore extends the session. The locked setup keeps sliding-window context compression on, so a long conversation does not end on context length.

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

On OpenAI the browser sends its SDP offer to the BFF and receives only a session ID and SDP answer. On Gemini it receives only an endpoint, a single-use token, the locked setup, and an expiry. Never expose `OPENAI_API_KEY` or `GEMINI_API_KEY` to the demo or any consuming application.

## React usage

```tsx
import { useMemo, useState } from "react";
import { TranscriptView, VoiceVizCanvas } from "@jarvis-viz/react";
import { createLiveTransport, type VoiceViz } from "@jarvis-viz/core";

export function VoiceAssistant() {
  const [viz, setViz] = useState<VoiceViz | null>(null);
  const transport = useMemo(() => createLiveTransport({ protocol: "openai-live" }), []);
  return (
    <>
      <VoiceVizCanvas
        autoConnect
        tokenEndpoint="https://your-bff.example/session"
        options={{ presets: ["ring", "hud"], theme: "cyan", transport }}
        onReady={setViz}
        style={{ height: 480 }}
      />
      {viz ? <TranscriptView store={viz.transcript} /> : null}
    </>
  );
}
```

`options.transport` is optional. Drop it to take the broker's first runnable protocol. Keep the transport object stable across renders, because a new object rebuilds the instance.

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

To pin a protocol, assign the `transport` property before the element connects.

```html
<jarvis-voice-viz id="voice" style="display:block;height:480px" token-endpoint="https://your-bff.example/session"></jarvis-voice-viz>

<script type="module">
  import { defineVoiceVizElement } from "@jarvis-viz/wc";
  import { createLiveTransport } from "@jarvis-viz/core";

  defineVoiceVizElement();
  const element = document.querySelector("#voice");
  element.transport = createLiveTransport({ protocol: "gemini-live" });
  await element.connect();
</script>
```

`transport` is a JavaScript property, so it takes an object rather than a string. The element has no `live-provider` attribute. Assigning it during a live session throws; disconnect first.

The existing React `tokenEndpoint` prop and web component `token-endpoint` attribute name the broker URL. Their names remain compatible with existing hosts. The custom element renders inside Shadow DOM. Available themes are `cyan`, `amber`, `rose`,
`spectrum`, `coast`, `ultraviolet`, and `magenta`.

During local development, `/embed.html` is a reproducible web-component host page with
deliberately hostile global canvas and typography CSS. The internal canvas remains isolated by
the component's Shadow DOM.

## Bun BFF (Backend For Frontend)

The BFF is a demo service with no application auth. Copy `server/.env.example` to `server/.env`. `server/src/config.ts` reads these variables.

Required, at least one of:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

A Gemini-only BFF needs no `OPENAI_API_KEY`, and an OpenAI-only BFF needs no `GEMINI_API_KEY`. Startup fails when neither key is set.

Optional, with defaults:

- `OPENAI_LIVE_MODEL`, default `gpt-live-1`
- `OPENAI_LIVE_BACKEND_MODEL`, default `gpt-5.6-luna`
- `GEMINI_LIVE_MODEL`, default `gemini-3.8-live`, or `gemini-3.8-live-extended-thinking`
- `LIVE_PROVIDERS`, default every keyed provider
- `ALLOWED_ORIGINS`, default `http://localhost:5180`
- `PORT`, default `3010`
- `RATE_LIMIT_REQUESTS`, default `8`
- `RATE_LIMIT_WINDOW_MS`, default `60000`
- `SESSION_BUDGET_REQUESTS`, default `30`
- `SESSION_BUDGET_WINDOW_MS`, default `3600000`
- `MAX_OUTPUT_TOKENS`, default `768`, range 16 to 4096
- `LIFETIME_STREAMS_PER_ORIGIN`, default `4`

`MAX_OUTPUT_TOKENS` caps delegated Responses output on OpenAI. It does not cap spoken audio, and Gemini does not use it.

`LIVE_PROVIDERS` orders the keyed providers on the lease, as in `LIVE_PROVIDERS=gemini-live,openai-live`. The first entry wins when a host pins no protocol. List only protocols whose key you set. An unkeyed entry stops startup, and so does a repeated or unknown name. The default order follows the keys the BFF holds.

There is no `GEMINI_LIVE_BACKEND_MODEL`. Setting it stops startup, because Gemini Live has no delegation protocol. Choose Gemini reasoning with `GEMINI_LIVE_MODEL` instead.

Run `pnpm dev:server`. Production builds use:

```bash
pnpm --filter @jarvis-viz/server build
pnpm --filter @jarvis-viz/server start
```

Install the Bun version pinned in `.bun-version`. pnpm remains the only dependency installer;
do not run `bun install` or commit a Bun lockfile.
