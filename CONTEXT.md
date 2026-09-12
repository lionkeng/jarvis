# Architecture context

The original repository was a single Vite playback experiment under root `src/`. It is now organized around independent deployment and publishing boundaries.

## Dependency direction

```text
apps/demo (voice SPA + XState) ---+
packages/react -------------------+--> packages/core --> @chenglou/pretext
packages/wc ----------------------+

browser --POST /session--> server (Bun) --> OpenAI live/sessions
browser --WebRTC (audio + tool calls) --> OpenAI GPT-Live
```

`packages/core` has no React, XState, or server dependency. Renderer code consumes normalized state, features, regions, and theme contracts. Raw OpenAI event names are isolated to `packages/core/src/transport/`. The Bun server contains no browser code and never receives conversation audio, transcript content, or live tool calls after it exchanges the SDP offer. The voice-first demo owns the interaction actor and capability registry.

## Runtime ownership

- pnpm installs and links every workspace package and owns `pnpm-lock.yaml`.
- Vite runs and builds the demo.
- TypeScript emits the three publishable packages.
- Bun runs, tests, and bundles the BFF.
- Canvas 2D remains the production renderer. The hot loop does not require Three.js or WebGPU.

## Security posture

The BFF validates exact origins, applies a short rate window and a longer per-origin issuance budget, and fixes the Live voice model, voice, Responses backend model, and backend output-token limit server-side. The `GET /session` lifetime stream requires the same allowed origin, and each origin may hold at most `LIFETIME_STREAMS_PER_ORIGIN` streams. Live handles context automatically. Responses are `no-store`. The long-lived OpenAI API key exists only in the Bun process.

The session advertises an exact `perform_ui_actions` grammar. The browser parser still treats tool arguments as untrusted. A tool result is the call ID and the output JSON. Live collects function calls from nested Responses output items, returns every required result, and then continues backend work. Voice prompts request brief success acknowledgements and silent cancellation. Live speech continues independently of backend work. Provider errors and failed backend responses are reported as `provider-error` and `backend-failed` events and never close the session. Only `session.closed`, peer loss, or lifetime-stream loss end it.

Startup waits for `session.started`. Shutdown stops the microphone at once, then waits for `session.closed` with a 15-second fallback before releasing the peer connection. Timed user and assistant caption fragments are stored independently, and a Live disconnect completes the last caption row instead of marking it interrupted. The remote audio analyser drives the Live speaking indicator.

Each Live session first opens a persistent `GET /session` lifetime stream to its broker. Five-second server heartbeats keep the stream active, and the Bun server sets a 30-second idle timeout so that cadence is not tied to Bun's default. EOF, a read error, or 15 seconds without data requests provider closure and immediately releases browser media. The stream shares the session's abort lifecycle. Server process shutdown therefore also ends browser voice sessions, while explicit user disconnect retains the final-usage drain. The server does not record Live session IDs, so that guarantee depends on the browser holding the stream.
