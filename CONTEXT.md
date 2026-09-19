# Architecture context

The original repository was a single Vite playback experiment under root `src/`. It is now organized around independent deployment and publishing boundaries.

## Dependency direction

```text
apps/demo (voice SPA + XState) ---+
packages/react -------------------+--> packages/core --> @chenglou/pretext
packages/wc ----------------------+

browser --GET /session (lease, protocol list)--> server (Bun)
browser --POST /session--> server (Bun) --> OpenAI live/sessions
browser --POST /session--> server (Bun) --> Google auth_tokens
browser --WebRTC (audio + tool calls) --> OpenAI GPT-Live
browser --WebSocket (PCM audio + tool calls) --> Gemini 3.8 Live
```

`packages/core` has no React, XState, or server dependency. Renderer code consumes normalized state, features, regions, and theme contracts. Raw OpenAI and Gemini Live event names are isolated to `packages/core/src/transport/`. The Bun server contains no browser code. It never receives conversation audio, transcript content, or live tool calls after it exchanges the SDP offer or mints the Gemini token. The voice-first demo owns the interaction actor and capability registry.

One broker handshake serves both protocols. `GET /session` returns the lease, and its `ready` event lists the protocol ids the BFF has keys for. `POST /session` takes a flat body with an optional `protocol`. The OpenAI grant stays `{ session, transport }`. The Gemini grant is `{ kind: "websocket-token", endpoint, token, setup, expiresAt }`.

## Runtime ownership

- pnpm installs and links every workspace package and owns `pnpm-lock.yaml`.
- Vite runs and builds the demo.
- TypeScript emits the three publishable packages.
- Bun runs, tests, and bundles the BFF.
- Canvas 2D remains the production renderer. The hot loop does not require Three.js or WebGPU.

## Security posture

The BFF validates exact origins, applies a short rate window and a longer per-origin issuance budget, and fixes the Live voice model, voice, Responses backend model, and backend output-token limit server-side. The origin guard, the rate limit, the session budget, and the stream cap apply to both protocols equally. The `GET /session` lifetime stream requires the same allowed origin, and each origin may hold at most `LIFETIME_STREAMS_PER_ORIGIN` streams. Live handles context automatically. Responses are `no-store`. The long-lived OpenAI and Gemini API keys exist only in the Bun process.

Each Gemini connection gets one single-use ephemeral token. It expires after 30 minutes and has 1 minute to start a session. Google locks the model and every setup field the token's field mask names, so the browser cannot change the tools, the system instruction, the voice, or transcription. `sessionResumption` is the one setup field the mask leaves open, which is how the browser carries its resumption handle into a new connection. The browser opens the WebSocket to Google itself, so conversation audio, transcripts, and tool calls never enter the Bun process. The expiry timer follows the newest grant, so a reconnect extends the session.

The session advertises an exact `perform_ui_actions` grammar. The browser parser still treats tool arguments as untrusted. A tool result is the call ID and the output JSON. Live collects function calls from nested Responses output items, returns every required result, and then continues backend work. Voice prompts request brief success acknowledgements and silent cancellation. Live speech continues independently of backend work. Provider errors and failed backend responses are reported as `provider-error` and `backend-failed` events and never close the session. Only `session.closed`, peer loss, or lifetime-stream loss end it. Gemini emits no `session-usage`, `backend-usage`, or `backend-failed` event, and Google discards its pending function calls when it reports an interruption.

Each channel owns its close discipline. OpenAI startup waits for `session.started`. Its shutdown stops the microphone at once, sends `session.close`, then waits up to 15 seconds for `session.closed` before releasing the peer connection. Gemini shutdown stops capture and closes the socket with code 1000, with a 2 second fallback and no wait for a provider message. Lease loss aborts either channel at once.

Google closes each Gemini connection after about 10 minutes. Google's documentation describes a `goAway` message before the close. In live runs the connection closed with code 1011 and no `goAway`. The channel treats both as routine and reconnects.

A reconnect asks the broker for a fresh grant, then dials with the new token and the latest session resumption handle. A single-use token cannot open a second connection, so every reconnect is another `POST /session`. That POST passes the origin guard, the rate limit, and the session budget, and spends one slot of each. A long Gemini session therefore draws down the per-origin session budget as it runs. The reconnect keeps the same agent audio stream, drops pending tool calls, and emits no `disconnected` and no second `connected`.

The channel fails closed with an error instead of reconnecting in five cases. No resumable handle exists. The close code is 1007 or 1008. The new grant fails, which includes a 429 from the broker. The dial fails. A reconnected socket closes within 10 seconds of its own setup.

Timed user and assistant caption fragments are stored independently, and an OpenAI disconnect completes the last caption row instead of marking it interrupted. Gemini transcripts carry no timestamps, so the channel emits audio-paced text deltas and no timed caption rows. The agent audio analyser drives the Live speaking indicator on both protocols. Gemini playback goes into a `MediaStream` that `VoiceViz` monitors, so it never reaches the speakers a second time.

Each Live session first opens a persistent `GET /session` lifetime stream to its broker. Five-second server heartbeats keep the stream active, and the Bun server sets a 30-second idle timeout so that cadence is not tied to Bun's default. EOF, a read error, or 15 seconds without data requests provider closure and immediately releases browser media, on both protocols. The stream shares the session's abort lifecycle. Server process shutdown therefore also ends browser voice sessions, while explicit user disconnect retains the final-usage drain. The server does not record Live session IDs, so that guarantee depends on the browser holding the stream.
