# Architecture context

The original repository was a single Vite playback experiment under root `src/`. It is now organized around independent deployment and publishing boundaries.

## Dependency direction

```text
apps/demo (voice SPA + XState) ---+
packages/react -------------------+--> packages/core --> @chenglou/pretext
packages/wc ----------------------+

browser --POST /session--> server (Bun) --> OpenAI client_secrets
browser --WebRTC (audio + tool calls) --> OpenAI realtime/calls
```

`packages/core` has no React, XState, or server dependency. Renderer code consumes normalized state, features, regions, and theme contracts. Raw OpenAI event names are isolated to `packages/core/src/transport/openai.ts`. The Bun server contains no browser code and never receives conversation audio, transcript content, or live tool calls after it mints the session. The voice-first demo owns the interaction actor and capability registry.

## Runtime ownership

- pnpm installs and links every workspace package and owns `pnpm-lock.yaml`.
- Vite runs and builds the demo.
- TypeScript emits the three publishable packages.
- Bun runs, tests, and bundles the BFF.
- Canvas 2D remains the production renderer. The hot loop does not require Three.js or WebGPU.

## Security posture

The BFF validates exact origins, applies a short rate window and a longer per-origin issuance budget, and fixes Realtime model, voice, output-token, and context-token limits server-side. Tracing is on by default (`OPENAI_REALTIME_TRACING`). Responses are `no-store`. The long-lived OpenAI API key exists only in the Bun process.

The session advertises an exact `perform_ui_actions` grammar. The browser parser still treats tool arguments as untrusted. After a voice result, core carries a required `followUp` intent. Success acknowledgements are tool-less and response-scoped. Cancellation stays silent.
