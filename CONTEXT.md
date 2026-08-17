# Architecture context

The original repository was a single Vite playback experiment under root `src/`. It is now organized around independent deployment and publishing boundaries.

## Dependency direction

```text
apps/demo ----------------┐
packages/react -----------+--> packages/core --> @chenglou/pretext
packages/wc --------------┘

browser --POST /session--> server (Bun) --> OpenAI client_secrets
browser --WebRTC-------------------------> OpenAI realtime/calls
```

`packages/core` has no React or server dependency. Renderer code consumes normalized state, features, regions, and theme contracts. Raw OpenAI event names are isolated to `packages/core/src/transport/openai.ts`. The Bun server contains no browser code and never receives conversation audio or transcript content.

## Runtime ownership

- pnpm installs and links every workspace package and owns `pnpm-lock.yaml`.
- Vite runs and builds the demo.
- TypeScript emits the three publishable packages.
- Bun runs, tests, and bundles the BFF.
- Canvas 2D remains the production renderer. The hot loop does not require Three.js or WebGPU.

## Security posture

The BFF validates exact origins, applies a short rate window and a longer per-origin issuance budget, and fixes Realtime model, voice, output-token, and context-token limits server-side. Responses are `no-store`. The long-lived OpenAI API key exists only in the Bun process.
