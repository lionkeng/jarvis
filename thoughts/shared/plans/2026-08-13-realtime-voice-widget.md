# Realtime Voice Visualization Widget

**Date:** 2026-08-13
**Status:** Implemented — automated verification complete; live/manual sign-off pending

---

## Context

Before this implementation, the repo was a **music visualizer**. It loaded `skyfall.mp3`,
fetched timed `.lrc` lyrics from LRCLIB, and animated them on a canvas using
`@chenglou/pretext` for text layout.

The implemented direction is a **shareable, embeddable widget that visualizes a duplex voice LLM**
(GPT-Realtime), Jarvis-*like* in feel but not locked to that aesthetic:

- Only the **agent's** audio stream is visualized. User mic audio is not.
- The agent's text streams into a **scrollable panel**, laid out by Pretext and paced against
  locally audible agent speech, flowing calmly like streaming text — **not** the per-token
  bouncing the current lyric renderer does or a transcript racing ahead of WebRTC playout.
- Panel placement is **responsive to the embedded canvas width**: side panel when wide,
  lower panel when narrow.
- **All existing visualization styles remain available as options**, and styling is
  customizable — multi-hue palettes stay.
- A **full transcript** of both sides is recorded and viewable in an **optional view**.
- A **Bun-based LLM BFF backend** mints ephemeral session tokens.

The architecture is better positioned for this than it looks: only `src/main.ts` touches the
DOM (10 references), and every other module is framework-free. The seam that matters is the
`AnalyserNode` — everything downstream of it survives, everything upstream is replaced.

**Non-goal:** this is not a React rewrite. See [Packaging](#packaging).

---

## Widget shape

The canvas splits into two regions whose arrangement is chosen from the **container**
dimensions, not the viewport.

**Wide container → side panel**

```
┌────────────────────────────────┬──────────────────┐
│                                │  Good evening.   │
│          ◜◝  ◜◝  ◜◝            │  All systems     │
│       ((     ●     ))          │  are nominal.    │
│          ◟◞  ◟◞  ◟◞            │  I've finished   │
│                                │  the analysis  ▌ │
│        [ viz region ]          │                  │
└────────────────────────────────┴──────────────────┘
                                   scrollable, Pretext
```

**Narrow container → lower panel**

```
┌──────────────────────────┐
│       ◜◝  ◜◝  ◜◝         │
│    ((     ●     ))       │
│       ◟◞  ◟◞  ◟◞         │
├──────────────────────────┤
│  Good evening. All       │
│  systems are nominal.  ▌ │
└──────────────────────────┘
```

Breakpoint is configurable, defaulting to side-panel when `w >= 640 && w/h >= 1.2`. Consumers
can force either arrangement. Changing arrangement changes wrap width, which forces a
re-layout of scrollback — see [Phase 3](#phase-3--streaming-text-panel-hardest-piece).

---

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Canvas text | Calm streaming flow in a scrollable Pretext panel | `LyricLayout` primitives survive; `LyricMotion` retires as default |
| Text motion | `flow` preset default; today's behavior preserved as opt-in `kinetic` | 256 lines of choreography kept as an option, not deleted |
| Viz styles | All existing styles become selectable presets | Nothing in the current renderer is thrown away |
| Palettes | Multi-hue, customizable; existing four retained | `paletteForTime` cycling becomes an option, not a default |
| Visualizer customization | Presets + theme tokens; `Visualizer` interface internal in v1 | `VizFrame` need not be frozen yet; promotion later is an export, not a redesign |
| Realtime transport | Thin interface, OpenAI-only implementation | No OpenAI event names outside `transport/openai.ts` |
| Audio/text synchronization | Queue audio-transcript deltas and release words from locally observed speech time | WebRTC transcript events have no word-level playout clock; text-only responses remain immediate |
| Live pacing controls | Response timing (`fast`, `natural`, `patient`) plus speech speed (`0.75x`-`1.25x`) | Bun validates preferences; transcript release uses the same speech-rate multiplier |
| Transcript | Client-only, ephemeral | BFF stays stateless; no retention or privacy scope |
| UI framework | Framework-free core + React adapter | Canvas is imperative; only the transcript view is DOM |
| Production renderer | Canvas 2D for v1; no Three.js/WebGPU dependency | Best fit for the retained 2D primitives and Pretext panel; preserves a small embed and one render lifecycle |
| BFF runtime | Bun (`Bun.serve`, `bun:test`, Bun-target build) | No Node server framework; pnpm remains the workspace installer/lockfile owner |

### Three.js and WebGPU decision

There is no immediate implementation benefit large enough to justify putting Three.js and
WebGPU on the v1 critical path. The workload is a small set of 2D paths, bars, text, and a
bounded particle system driven by one analyser read per frame. Canvas 2D already expresses
those operations directly, shares a canvas-native model with Pretext, and avoids a second scene
graph, GPU resource lifecycle, fallback path, and larger consumer bundle.

WebGPU becomes worth a focused spike when a concrete visual requires one of these capabilities:

- tens of thousands of particles, shader-based fields, spectrogram textures, 3D geometry, or
  multi-pass post-processing;
- compute work that can move meaningfully off the CPU; or
- measured misses against the 16 ms frame budget on supported target devices that Canvas 2D
  optimization cannot fix.

If one of those triggers occurs, prototype a single visualization preset behind the internal
renderer boundary. Compare steady-state frame time, idle power, initialization time, bundle
cost, and fallback behavior against the Canvas 2D preset. Do not move the Pretext panel or the
whole renderer to Three.js merely to run that experiment. The internal `VisualizationPreset`
and `VizFrame` seams leave room for a later GPU-backed preset or renderer without changing the
public `VoiceViz` API.

---

## Migration ledger

| Status | Files / ranges | Notes |
|---|---|---|
| **Delete** | `src/lrc-parser.ts`, `src/lyrics-fetch.ts`, `src/lyrics-source.ts`, `src/lyrics.ts` (~448 lines) + their three test files | Timed-lyric problem no longer exists |
| **Delete** | `src/audio.ts:43-128` — `loadUrl`, `loadArrayBuffer`, `play`, `pause`, `seekTo`, `stop`, `duration` | Can't `decodeAudioData` a stream; can't seek a conversation |
| **Delete** | Transport UI: `src/main.ts:94-111`, `index.html:209-227` | Seek bar / duration / play-pause are meaningless live |
| **Adapt** | `src/audio.ts:130-168` (`getMetrics`) | Preserve the pure analyser-read seam in `packages/core/src/audio/`, but retune music-oriented bands for 24 kHz speech and expose speech features |
| **Keep intact** | `src/lyric-layout.ts` prepare + caches + `tokensForLine` + `sliceWidth` + `getGraphemes` | Core Pretext plumbing moves to `packages/core/src/text/pretext-layout.ts` |
| **Keep intact** | `src/beat-detect.ts:138-142` (`getCharFrequency`) | Pure FFT-bin indexing moves to `packages/core/src/text/motion/kinetic.ts` |
| **Keep as preset** | `drawFrequencyBars`, `drawWaveform`, `drawCircularViz`, particles (`src/main.ts:231-356`) | One selectable module per preset under `packages/core/src/render/presets/` |
| **Keep as preset** | `LyricMotion` (256 lines) | Becomes opt-in `kinetic` text preset, no longer default |
| **Keep as option** | Palettes + `paletteForTime` (`src/main.ts:197-207`) | Move to `packages/core/src/render/theme.ts`; cycling becomes opt-in |
| **Retire** | `layoutBalancedLines`, `balancedWrapWidth`, `layoutActiveLines`, `layoutShapedLines`, `variableLineWidth` (`src/lyric-layout.ts:149-224`) | Display-text shaping; a flowing panel wants plain greedy wrap |
| **Rewrite** | `src/beat-detect.ts` (148 lines) | Percussive vocabulary → `packages/core/src/audio/speech-features.ts` |
| **Rewrite** | `src/main.ts` (628 lines) | Split by ownership into the composition root, canvas renderer, presets, text motion, and demo shell described below |
| **Replace** | `detectLyricsLocale` (`src/lyric-layout.ts:227-243`) | Locale comes from config or session, not script sniffing |

Test coverage drops to near zero — only `beat-detect.test.ts` survives, and it covers just two
pure helpers. Coverage is rebuilt with each new owner: region splitting and initial speech
features in Phase 1, state transitions in Phase 2, append-stable wrapping in Phase 3, and the
transcript store in Phase 5. All are testable with synthetic input.

---

## Packaging

Ship a **framework-free core with thin adapters** — the Mapbox GL / Monaco / LiveKit pattern.
"Embeddable" means you cannot dictate the host's framework or React version.

```
packages/core    @jarvis-viz/core    canvas, audio graph, layout, state machine,
                                     transcript store. Only dep: @chenglou/pretext
packages/react   @jarvis-viz/react   ~100 lines of useRef + useEffect
packages/wc      @jarvis-viz/wc      custom element + Shadow DOM (Phase 6)
apps/demo        current Vite app → dev harness and public demo
server/          private Bun BFF for token minting
```

Before Phase 1, `pnpm-workspace.yaml` had only an `allowBuilds` key and no `packages:` list.
Phase 1 added explicit `packages/*`, `apps/*`, and `server` workspace globs while preserving
the build policy.

The repository intentionally splits **package management** from the BFF **runtime**. pnpm
installs every workspace and `pnpm-lock.yaml` remains the sole dependency lockfile; do not run
`bun install` or commit a second `bun.lock`. The private `server` package invokes Bun from its
scripts for development, tests, production bundling, and execution. CI and deployment must
install the same pinned Bun release before running those scripts.

### Target repository layout

The flat root `src/` is removed. This is the implemented end-state layout. Tests are colocated
with their owners, and generated `dist/` folders are ignored and created only by builds.

```text
.
├── .bun-version                       # Bun release shared by local, CI, and production
├── .github/workflows/verify.yml        # installs the pinned Bun + pnpm, then runs pnpm verify
├── package.json                       # workspace-wide scripts only
├── pnpm-workspace.yaml                # packages/*, apps/*, server
├── tsconfig.base.json                 # shared strict compiler options
├── scripts/
│   ├── check-boundaries.mjs           # executable import/ownership assertions
│   └── check-packages.mjs             # packed-tarball consumer and exports smoke test
├── packages/
│   ├── core/                          # @jarvis-viz/core; framework-free browser runtime
│   │   ├── package.json
│   │   ├── tsconfig.json / tsconfig.build.json
│   │   ├── src/
│   │   │   ├── index.ts               # deliberately small public export surface
│   │   │   ├── voice-viz.ts           # VoiceViz lifecycle and composition root
│   │   │   ├── audio/
│   │   │   │   ├── types.ts           # VoiceFeatures and analyser sample contracts
│   │   │   │   ├── media-stream-analyser.ts
│   │   │   │   ├── speech-features.ts
│   │   │   │   ├── speech-features.test.ts
│   │   │   │   └── idle-features.ts
│   │   │   ├── transport/
│   │   │   │   ├── types.ts           # provider-neutral events + RealtimeTransport
│   │   │   │   └── openai.ts          # the only browser file that knows OpenAI events
│   │   │   ├── state/
│   │   │   │   ├── types.ts           # AgentState
│   │   │   │   ├── state-machine.ts
│   │   │   │   └── state-machine.test.ts
│   │   │   ├── layout/
│   │   │   │   ├── types.ts           # Rect, Regions, PanelPlacement
│   │   │   │   ├── regions.ts         # container-relative region splitter
│   │   │   │   └── regions.test.ts
│   │   │   ├── text/
│   │   │   │   ├── audio-text-sync.ts # audible-time word queue for audio transcripts
│   │   │   │   ├── audio-text-sync.test.ts
│   │   │   │   ├── pretext-layout.ts  # retained Pretext prepare/measure primitives
│   │   │   │   ├── streaming-panel.ts # append-stable lines, virtualization, paint
│   │   │   │   ├── streaming-panel.test.ts
│   │   │   │   ├── panel-input.ts     # wheel, drag, scrollbar, pin-to-bottom
│   │   │   │   └── motion/
│   │   │   │       ├── flow.ts
│   │   │   │       └── kinetic.ts     # retained LyricMotion behavior
│   │   │   ├── render/
│   │   │   │   ├── types.ts           # internal VizFrame and Visualizer
│   │   │   │   ├── canvas-renderer.ts # RAF, layer ordering, clipping, trail pass
│   │   │   │   ├── registry.ts        # named preset resolution
│   │   │   │   ├── theme.ts           # palettes and theme normalization
│   │   │   │   ├── color.ts
│   │   │   │   └── presets/
│   │   │   │       ├── index.ts
│   │   │   │       ├── bars.ts
│   │   │   │       ├── waveform.ts
│   │   │   │       ├── ring.ts
│   │   │   │       ├── particles.ts
│   │   │   │       └── hud.ts
│   │   │   └── transcript/
│   │   │       ├── types.ts
│   │   │       ├── store.ts
│   │   │       └── store.test.ts
│   │   └── src/test/
│   │       └── voice-viz.integration.test.ts
│   ├── react/                         # @jarvis-viz/react; created in Phase 5
│   │   ├── package.json
│   │   ├── tsconfig.json / tsconfig.build.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── voice-viz-canvas.tsx   # useRef/useEffect adapter
│   │       └── transcript-view.tsx    # replaceable accessible default
│   └── wc/                            # @jarvis-viz/wc; created in Phase 6
│       ├── package.json
│       ├── tsconfig.json / tsconfig.build.json
│       └── src/
│           ├── index.ts
│           ├── voice-viz-element.ts   # lifecycle plus Shadow DOM-local styles
│           └── styles.ts              # web-component-owned :host and mount CSS
├── apps/
│   └── demo/                          # @jarvis-viz/demo; private Vite harness
│       ├── package.json
│       ├── tsconfig.json
│       ├── index.html
│       ├── embed.html                 # reproducible hostile-CSS custom-element host
│       ├── vite.config.ts             # builds both demo and embed entries
│       └── src/
│           ├── App.tsx                # controls and three simultaneous host sizes
│           ├── demo-transport.ts      # credential-free normalized-event simulation
│           ├── embed.ts / embed.css   # web-component isolation harness
│           ├── main.tsx
│           └── styles.css
└── server/                             # @jarvis-viz/server; private Bun BFF; Phase 6
    ├── package.json                    # Bun-backed scripts; dependencies installed by pnpm
    ├── tsconfig.json                   # extends base; adds Bun types
    ├── bunfig.toml                     # Bun test/runtime configuration
    ├── .env.example                    # documented environment contract; no real secret
    └── src/
        ├── index.ts
        ├── index.test.ts               # real Bun HTTP listener boundary
        ├── config.ts
        ├── routes/session.ts
        ├── routes/session.test.ts
        ├── providers/openai-session.ts
        ├── providers/openai-session.test.ts
        └── guards/
            ├── origin.ts
            ├── origin.test.ts
            ├── rate-limit.ts
            ├── rate-limit.test.ts
            ├── budget.ts
            └── budget.test.ts
```

Tests live beside the pure module they exercise; only cross-module lifecycle tests go in a
package-level `test/` directory. This makes ownership obvious and avoids a second tree that
mirrors `src/`. `scripts/check-boundaries.mjs` is the repository-level architecture test: it
scans static imports and fails on the forbidden dependency edges below. Extend its rules as
React, WC, and server packages are introduced.

### Module ownership

| Path | Owns | Explicitly does not own |
|---|---|---|
| `packages/core/src/voice-viz.ts` | `VoiceViz`, lifecycle, construction, and wiring transport events to stores/state | Provider event parsing, DSP math, frame scheduling, drawing algorithms |
| `packages/core/src/audio/` | Remote-track attachment, `AnalyserNode` reads, speech feature extraction, idle feature synthesis | WebRTC signaling, application state transitions, rendering |
| `packages/core/src/transport/` | Provider-neutral transport contract and OpenAI WebRTC/event translation | Canvas, Pretext, transcript presentation, visual state policy |
| `packages/core/src/state/` | Deterministic transition from normalized events to `AgentState` | OpenAI event names, audio threshold guesses, drawing |
| `packages/core/src/layout/` | Container measurement types and pure `Regions` calculation | DOM observation, text wrapping, painting |
| `packages/core/src/text/` | Audible-time transcript pacing, Pretext preparation, append-stable wrapping, scroll model/input, panel painting, text motion | Conversation retention, visualization presets, transport parsing |
| `packages/core/src/render/` | Canvas frame scheduling, viz clipping/layers, theme resolution, presets and their private state | Text layout, audio graph ownership, DOM controls |
| `packages/core/src/transcript/` | Provider-neutral, append-only session transcript data | Persistence, networking, framework UI |
| `packages/react/` and `packages/wc/` | Host-framework lifecycle and presentation adapters | Duplicate engine, audio, state, or layout logic |
| `apps/demo/` | Examples, connection form, preset/theme controls, manual test harness | Reusable widget behavior |
| `server/` | Bun HTTP runtime, ephemeral token minting, and origin/rate/budget enforcement | Conversation state, transcripts, browser transport/rendering, Node-only server APIs |

`voice-viz.ts` is a **composition root**, not another implementation bucket. It constructs the
subsystems and forwards normalized data between them; behavior stays in the owning directory.
If it starts accumulating provider switches, drawing code, feature math, or panel behavior,
that code belongs in one of the modules above.

### Dependency and export rules

The intended dependency direction is:

```text
packages/react ─┐
packages/wc ────┼──> @jarvis-viz/core public index
apps/demo ──────┘

voice-viz (composition root)
  ├──> transport ──> transport/types
  ├──> audio ──────> audio/types
  ├──> state ──────> state/types + transport/types
  ├──> layout ─────> layout/types
  ├──> text ───────> @chenglou/pretext + layout/types
  ├──> render ─────> audio/types + state/types + layout/types
  └──> transcript

server     (no import edge to or from browser packages)
```

- `packages/core/src/index.ts` exports only `VoiceViz`, consumer configuration/event types,
  `AgentState`, theme/preset names, and transcript read/subscribe contracts. `Visualizer`,
  `VizFrame`, concrete OpenAI transport classes, analyser internals, and Pretext layout boxes
  remain internal in v1.
- Cross-package imports use package entry points (`@jarvis-viz/core`), never paths such as
  `@jarvis-viz/core/src/render/types`. Each package declares an `exports` map that enforces it.
- The root `check:boundaries` script runs `scripts/check-boundaries.mjs`; ownership rules are
  executable CI constraints, not review-only conventions.
- Within core, dependencies point toward leaf contracts (`*/types.ts`). Type-only consumers use
  `import type`; a types module must not import a runtime implementation.
- `transport/openai.ts` is the only browser module allowed to contain OpenAI Realtime event
  names. The state machine, transcript store, and renderer receive normalized events/data.
- `render/` may consume `VoiceFeatures`, `AgentState`, and `Regions` values, but it may not pull
  samples from an analyser or initiate state transitions.
- Adapters mount and dispose `VoiceViz`; they do not fork its logic. React is a peer dependency
  of `@jarvis-viz/react`, never a dependency of core.
- `apps/demo` may import package public APIs, but packages may never import the demo. `server/`
  shares request/response shapes through HTTP, not by importing browser-core implementation.
- `server/src/index.ts` is the only HTTP listener and starts `Bun.serve`; routes and guards are
  ordinary functions over Fetch API `Request`/`Response` values. Server tests use `bun:test`.
- `server/src/config.ts` is the only module that reads `Bun.env`. It validates required secrets
  and limits once at startup; no route or provider reaches into global environment state.
- Bun is the server runtime and build target, but pnpm is the only installer. The architecture
  check rejects `bun.lock`, Node HTTP imports, and browser-package imports from `server/`.
- Do not create a generic `utils/`, `common/`, or `shared/` dumping ground. Keep helpers with
  their owning domain until a real second owner makes extraction necessary.

### Current-to-target file map

This is the concrete disposition of the current flat `src/` tree:

| Current source | Target | Treatment |
|---|---|---|
| `src/main.ts:41-67,556-599` | `packages/core/src/voice-viz.ts`, `packages/core/src/render/canvas-renderer.ts`, `apps/demo/src/App.tsx` | Separate reusable lifecycle/render loop from demo DOM controls |
| `src/main.ts:197-229` | `packages/core/src/render/theme.ts`, `packages/core/src/render/color.ts` | Retain palettes and color helpers; make palette mode explicit |
| `src/main.ts:231-356` | `packages/core/src/render/presets/{particles,bars,waveform,ring}.ts` | One registered preset per file; all coordinates use `regions.viz` |
| `src/main.ts:358-509` | `packages/core/src/text/motion/kinetic.ts` and the Phase 3 panel painter | Preserve adaptable bounce/split/glow choreography as opt-in kinetic motion; remove timed-lyric lookup/fade assumptions |
| `src/main.ts:511-550` (`drawContextLyrics`) | deleted | Timed previous/next lyric context is replaced by the streaming panel's real scrollback |
| `src/main.ts:601-620` | `packages/core/src/audio/idle-features.ts` | Retain idle synthesis behind the same `VoiceFeatures` contract as live audio |
| Remaining playback/lyrics UI in `src/main.ts` | deleted or demo-only connection controls in `apps/demo/src/App.tsx` | Do not move seek/play/duration behavior into core |
| `src/audio.ts:28-41,130-168` | `packages/core/src/audio/media-stream-analyser.ts`, `packages/core/src/audio/speech-features.ts` | Replace buffer source with remote `MediaStreamTrack`; preserve analyser read seam, retune bands for 24 kHz speech |
| `src/audio.ts:43-128` | deleted | File loading, decoding, seeking, and track playback do not apply to a live conversation |
| `src/beat-detect.ts` | `packages/core/src/audio/speech-features.ts`; `getCharFrequency` moves with kinetic motion | Replace music beat gates with speech features |
| `src/lyric-layout.ts` | `packages/core/src/text/pretext-layout.ts`, `packages/core/src/text/streaming-panel.ts` | Keep prepare/measure primitives; replace display-text shaping with append-stable wrap |
| `src/lyric-motion.ts` | `packages/core/src/text/motion/kinetic.ts` | Retain as opt-in behavior, renamed around its new responsibility |
| `src/{lrc-parser,lyrics-fetch,lyrics-source,lyrics}.ts` and tests | deleted | Timed lyric acquisition/resolution is not part of the widget |
| `src/beat-detect.test.ts` | split into `audio/speech-features.test.ts` and kinetic-motion tests where needed | Test the new owners rather than preserve the old file boundary |
| `src/vite-env.d.ts` | deleted | Current Vite types are supplied by the demo's TypeScript configuration; no ambient root declaration remains |
| Root `index.html` and page CSS | `apps/demo/index.html`, `apps/demo/src/styles.css` | Keep demo styling scoped; no page-global styles in core |
| `public/skyfall.mp3` | deleted after the Phase 0 live-audio spike | The published widget and final demo do not ship a copyrighted/sample track dependency |

At the end of Phase 1 there is no root `src/`. Later phases add files within these domain
directories; they do not reintroduce a flat package source directory.

React does nothing inside the widget — the widget is a canvas. The one genuinely DOM-shaped
surface is the optional transcript view, which ships as a **replaceable default component**.

**Style isolation is mandatory.** `index.html:10` (`* { margin: 0 }`) and `index.html:140`
(bare `button {}`) would vandalize any host page. Shadow DOM in the WC adapter, scoped classes
elsewhere.

---

## Core API

```ts
type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error'

type VoiceFeatures = {
  level: number          // smoothed RMS envelope
  onset: number          // syllable attack, decaying
  centroid: number       // spectral centroid, normalized
  voiced: boolean        // vowel vs fricative
  silenceMs: number
  frequencyData: Uint8Array
  waveformData: Uint8Array
}

type PanelPlacement = 'side' | 'bottom'

type Regions = {
  viz:   { x: number; y: number; w: number; h: number }
  panel: { x: number; y: number; w: number; h: number }
  placement: PanelPlacement
}

type VizFrame = {
  ctx: CanvasRenderingContext2D
  size: { w: number; h: number; dpr: number }   // container, never viewport
  regions: Regions
  t: number; dt: number
  state: AgentState; stateAge: number
  voice: VoiceFeatures
  theme: Theme
}

// INTERNAL in v1 — not exported. Designed as if public so it can be promoted
// later without redesign, but VizFrame stays unfrozen until it survives real use.
type Visualizer = {
  id: string
  layer: 'background' | 'field' | 'foreground'
  draw(frame: VizFrame): void
}

type Theme = {
  palette: PaletteName | readonly string[]   // 4 existing palettes + new ones + custom
  paletteMode: 'fixed' | 'cycle' | 'state'   // 'cycle' = today's 15s rotation
  textMotion: 'flow' | 'kinetic'             // 'kinetic' = today's bounce, opt-in
  density: number; strokeWeight: number; scale: number
  trailOpacity: number
}

// Thin seam so a second provider (Gemini Live, etc.) can slot in without
// reworking engine event plumbing. Only the OpenAI implementation ships.
type RealtimeTransport = {
  connect(tokenEndpoint: string): Promise<void>
  disconnect(): void
  readonly agentAudio: MediaStreamTrack | null
  subscribe(cb: (event: NormalizedRealtimeEvent) => void): Unsubscribe
}

class VoiceViz {
  mount(container: HTMLElement): void
  unmount(): void
  connect(tokenEndpoint: string): Promise<void>
  disconnect(): void
  setPresets(p: PresetName[]): void            // public customization surface
  setTheme(t: Partial<Theme>): void
  setPanelPlacement(p: PanelPlacement | 'auto'): void
  readonly transcript: TranscriptStore
  on(event, cb): Unsubscribe
}
```

Engine sorts visualizers by `layer` and clips each to `regions.viz` so a background preset
cannot paint into the text panel.

---

## Phases

### Phase 0 — Audio path spike (do first; highest risk)

Prove WebRTC → `MediaStreamAudioSourceNode` → existing analyser → existing `getMetrics()`
→ existing `drawCircularViz`. Everything else is moot if this doesn't hold.

- **Chrome gotcha:** an analyser on a WebRTC remote track reads **silence** unless the stream
  is also attached to an `<audio>` element. Attach a muted one.
- **Verify the band math.** Realtime output is 24 kHz PCM → Nyquist 12 kHz →
  `src/audio.ts:151-154`'s treble band (bins ~184-1024 ≈ 4.3-24 kHz) is structurally near-zero.
  Confirm against a live capture before designing anything around `treble`.

**Manual success:** a ring visibly reacts to real agent speech and falls back to idle motion
when the remote track is silent or detached.

### Phase 1 — Workspace split and core extraction

Do the reorganization immediately after the Phase 0 audio spike. This is not a blind directory
move and it is not a single new `engine.ts` that inherits everything from `main.ts`. Extract
bottom-up into the owners defined in [Module ownership](#module-ownership), keeping the demo
running after each step.

1. **Create the workspace boundary.**
   - Mark the root package private and make its `dev`, `typecheck`, `test`, and `build` scripts
     workspace aggregators. Add `check:boundaries` for the architecture script; root runtime
     dependencies move to their owning package.
   - Add `packages/*`, `apps/*`, and `server` to `pnpm-workspace.yaml` while keeping the current
     `allowBuilds` entry.
   - Move the shared strict options from root `tsconfig.json` into `tsconfig.base.json`. Every
     package extends it and declares its own `include`, DOM/JSX requirements, and output.
   - Create only `packages/core` and `apps/demo` in this phase. Give each a package name,
     scripts, TypeScript config, and explicit dependencies. Core owns `@chenglou/pretext`; the
     Vite dependency and browser entry HTML belong to the demo.

2. **Move the Vite application shell without changing behavior.**
   - Move root `index.html`, Vite environment types, and page CSS to `apps/demo` first. Keep
     `public/skyfall.mp3` under the demo only long enough to compare the extracted renderer
     with the old music path during this phase.
   - Point the root `dev` command to the demo. At this checkpoint the implementation may still
     import temporary files from root `src/`; this is an intermediate state, never a commit/tag
     advertised as the package boundary.

3. **Extract leaf modules before the orchestrator.**
   - Move palettes/colors to `packages/core/src/render/{theme,color}.ts`.
   - Move each existing visual into its own `packages/core/src/render/presets/*.ts` module. A
     preset owns its mutable state—`particles.ts`, for example, owns the particle array rather
     than a global array in the composition root.
   - Move retained Pretext preparation/measurement to
     `packages/core/src/text/pretext-layout.ts` and the existing `LyricMotion` implementation
     to `packages/core/src/text/motion/kinetic.ts`. Do not create `streaming-panel.ts` yet;
     Phase 3 introduces it with its tests.
   - Replace the playback-oriented `AudioEngine` with
     `packages/core/src/audio/media-stream-analyser.ts`. Move the analyser reads behind
     `packages/core/src/audio/types.ts`, establish the first `VoiceFeatures` extraction, and
     move idle synthesis to `idle-features.ts`. Phase 4 will visually retune those features
     after live speech profiling.
   - Add the pure `layout/regions.ts` splitter and its tests. It accepts container dimensions
     and placement configuration; it does not read the DOM.

4. **Create the two runtime owners.**
   - `packages/core/src/render/canvas-renderer.ts` owns `requestAnimationFrame`, layer sorting,
     clipping to `regions.viz`, trail clearing, and preset invocation. There must be one RAF
     owner.
   - `packages/core/src/voice-viz.ts` owns mount/unmount, canvas creation, `ResizeObserver`,
     subsystem construction, and disposal. It passes already-computed frame values to the
     renderer; it contains no preset drawing code.
   - **Container-relative sizing.** Current `src/main.ts:61-67` and `src/main.ts:563-564` read
     the viewport. `VoiceViz.mount()` instead observes its supplied container, updates the
     backing canvas for DPR, and calls the pure region splitter. Root/demo `100vh` and fixed
     positioning are not widget assumptions.

5. **Invert the demo dependency and remove the flat tree.**
   - `apps/demo/src/App.tsx` imports only the public exports of `@jarvis-viz/core` and
     `@jarvis-viz/react`, and owns demo-only controls/status. It may not deep-import package
     source files; `main.tsx` is only the Vite/React entry point.
   - Delete the timed-lyrics stack, playback controls, old root `src/`, and the demo track once
     the extracted ring reacts to the Phase 0 remote stream.
   - Search for stale imports and viewport reads. No compatibility re-export files remain at
     root; they would conceal violations of the package boundary.

**Automated success:**
- `pnpm --filter @jarvis-viz/core typecheck && pnpm --filter @jarvis-viz/core test` pass.
- `pnpm --filter @jarvis-viz/demo typecheck && pnpm --filter @jarvis-viz/demo build` pass.
- `pnpm check:boundaries` passes.
- `test ! -d src` succeeds at the repository root.
- `rg "innerWidth|innerHeight" packages/core` and
  `rg "@jarvis-viz/core/src|\.\./\.\./packages/core/src" apps/*/src packages/*/src` return no matches.
- Region-split tests cover the auto breakpoint, forced side/bottom placement, and zero/small
  container dimensions.

**Manual success:** the demo renders the same retained visuals from the idle signal and a
deterministic speech-shaped analyser fixture in 320×200 and 800×600 containers, switches placement at the
configured breakpoint, and mounts/unmounts repeatedly without leaving a `ResizeObserver`,
audio node, or RAF running. Phase 0 already proves the live-track path; Phase 2 wires it through
the permanent transport contract.

### Phase 2 — State machine, transport seam, preset registry

State is driven by **transport events, not DSP** — the mic is plumbing, not a signal source:

| Transport event | Transition |
|---|---|
| speech started (user) | → `listening` |
| speech stopped (user) | → `thinking` |
| first agent audio delta | → `speaking` |
| response done / silence timeout | → `idle` |
| user speech during `speaking` | → `interrupted` (barge-in) |

`thinking` is the state users stare at and the current code has no concept of it. Barge-in
needs a distinct visual — the viz should visibly yield.

Put these behind `RealtimeTransport` rather than reading OpenAI event names elsewhere in core.

Implement the boundary in `packages/core/src/transport/{types,openai}.ts` and the state policy in
`packages/core/src/state/agent-state-machine.ts`. `voice-viz.ts` subscribes to normalized
transport events and is the only module that wires transport, state, and audio-track attachment
together. Phase 5 adds transcript recording at that same composition boundary. The OpenAI
implementation receives a token endpoint; it does not know about canvas state or themes.

Convert the draw functions in `src/main.ts:231-356` into registered `Visualizer`s exposed as
**named presets** (`bars`, `waveform`, `ring`, `particles`, plus new HUD-style ones). Wire
`Theme.paletteMode` so the existing `paletteForTime` cycling (`src/main.ts:204-207`) becomes one
option among fixed and state-driven.

**Automated success:** all five transitions are unit-tested against synthetic normalized
transport events. The following returns no matches, and preset registry tests reject unknown
names and return presets in stable layer order:

```bash
rg "response\.|input_audio_buffer\.|session\." packages/core/src --glob '!**/transport/openai.ts'
```

**Manual success:** presets are selectable at runtime in the demo; a live session drives
listening/thinking/speaking/interrupted/idle states, and replacing the transport with a fake in
the integration test requires no renderer or state changes.

### Phase 3 — Streaming text panel (hardest piece)

**The problem.** `layoutActiveLines` (`src/lyric-layout.ts:205-224`) is balanced-wrap based — it
binary-searches wrap width over 12 iterations (`src/lyric-layout.ts:149-166`) then waist-shapes via
`variableLineWidth`. For a *growing* string that re-breaks every line above the tail on every
token. Text visibly reshuffles, and in a scrollback it would also jump the scroll position.
Separately, `prepareWithSegments` re-runs per delta against a cache keyed on full text
(`src/lyric-layout.ts:30,60-66`) — unbounded growth inside a 60fps loop.

**The design** — `packages/core/src/text/streaming-panel.ts`, supported by
`packages/core/src/text/audio-text-sync.ts`, `packages/core/src/text/pretext-layout.ts`, and
`packages/core/src/text/panel-input.ts`, reusing primitives currently imported at
`src/lyric-layout.ts:1-9`:

- **Audible-time transcript pacing.** OpenAI's WebRTC media track and data-channel transcript
  deltas are concurrent but do not expose a shared word-level playout timestamp. Buffer only
  audio-transcript deltas, wait until `VoiceFeatures` detects locally audible agent speech,
  and release append-stable word chunks at a conversational character rate while speech is
  audible. Pause the reveal during silence, flush the final tail only after a bounded audible
  silence window, and discard queued-but-unheard text on barge-in. Provider text-only deltas
  bypass this queue and remain immediate.

- **Append-stable greedy wrap.** Freeze committed lines; grow only the tail. Use
  `layoutNextLine(prepared, cursor, width)` with a persisted `LayoutCursor` — the pattern
  `layoutShapedLines` (`src/lyric-layout.ts:191-203`) already demonstrates. Plain greedy wrap is
  correct here; balanced wrap is for display text, not flowing prose.
- **Re-prepare only on word boundaries**, not every token — bounds prepare calls to word rate
  rather than token rate.
- **Virtualized scrollback.** Committed lines are stored as laid-out boxes with heights;
  scroll is a y-offset into that list; only lines intersecting `regions.panel` are drawn.
- **Scroll behavior.** Auto-pin to bottom while streaming; user wheel or drag unpins; a
  "jump to latest" affordance re-pins. Needs wheel + pointer-drag handling and a rendered
  scrollbar, since this is canvas, not DOM.
- **Re-layout on width change.** Panel placement flips or the container resizes → recompute
  all committed lines at the new width, preserving scroll anchor by line index.
- **Cache eviction** on utterance end via the existing `clear()` (`src/lyric-layout.ts:49-53`).

**Calm token reveal.** `LyricMotion.mapTokens` derives `phase` from `progress`
(`src/lyric-motion.ts:95-96`) — position within a line's known duration — then applies `springOut`
overshoot, `dropHeight`, rotation and `splitPulse`. That is exactly the bouncing to remove.

The default `flow` motion is a much smaller thing: per-token alpha ramp plus a few pixels of
vertical ease, driven by the **audio-synchronized release time** rather than provider delivery
time or a synthetic progress value.

```ts
phase = clamp((now - token.arrivedAt) / REVEAL_MS, 0, 1)
alpha = phase
offsetY = (1 - easeOut(phase)) * 4     // pixels, not the current 78+
```

`LyricMotion` is retained intact behind `theme.textMotion === 'kinetic'` for consumers who
want the expressive treatment.

**Automated success:** synthetic incremental text proves committed line breaks never change
while the tail grows; width-change tests preserve the anchored line; prepare-call counts scale
with word boundaries rather than raw deltas; panel input tests cover pin, unpin, drag, wheel,
and jump-to-latest behavior. Audio-text synchronization tests prove generated text stays hidden
before audible speech, advances only from audible time, flushes after the final silence window,
falls back when audio never arrives, and discards unheard text on interruption.

**Manual success:** a 200-word response streams with zero visible reflow jitter or scroll jump;
scrollback of 100+ lines stays at 60fps; placement flips preserve reading position; flow and
kinetic motion can be switched without resetting the transcript or scroll model. Spoken words
and displayed words remain perceptually aligned, text does not advance through audible pauses,
and barge-in never reveals the unplayed remainder of the interrupted response.

### Phase 4 — Visual system

Jarvis-*like*, not single-hue. The goal is a good default look plus real customization.

**Keep and promote:**
- `drawCircularViz` (`src/main.ts:321-356`) — radial FFT ring, already sized off `Math.min(w,h)`
  so it is container-relative and survives a sidebar. Good default.
- Trail fade (`src/main.ts:566-568`) — phosphor persistence; expose as `theme.trailOpacity`.
- Idle synthesis (`src/main.ts:601-620`) — promoted from fallback to core. The widget is silent
  most of the time and must never look dead.

**Adapt for the region split:** `drawFrequencyBars` (`src/main.ts:273-299`) anchors bars to the
bottom of the full canvas and mirrors at the top. Rebase it on `regions.viz` so it works in a
half-height or half-width region.

**Add:** concentric rotating arcs, tick marks, thin wireframe strokes, scanline/flicker as
additional presets. Add a Jarvis-leaning cyan/amber palette alongside the existing four.

**Retune viz reactivity.** `LyricMotion`'s mode selection (`src/lyric-motion.ts:56-60`) and
`BeatDetector`'s gates trigger on `bassBeat`/`trebleShimmer` thresholds tuned for music. The
primary beat gate (`src/beat-detect.ts:75`, `bass > avg * 1.4 && bass > 0.25`) drives `intensity`,
`beatCount`, most of `surge`, and all of `splitPulse` — speech rarely trips it. Rebind viz
intensity to `VoiceFeatures` and `AgentState` instead.

All additions land under existing owners: new visuals in
`packages/core/src/render/presets/`, palette and token changes in `render/theme.ts`, and feature
tuning in `audio/speech-features.ts`. Do not add Phase 4 drawing methods to `voice-viz.ts` or
create a second render loop.

**Automated success:** every named preset renders against a synthetic `VizFrame` without
painting outside `regions.viz`; theme normalization tests cover fixed/cycle/state palettes and
numeric bounds; no preset imports transport or analyser implementations.

**Manual success:** live agent speech produces useful motion across low, mid, and high voices;
idle/thinking remain alive without pretending speech is present; barge-in visibly yields; and
the 320×200, 800×600, and full-bleed demos remain under the 16 ms frame budget.

### Phase 5 — Transcript view and React adapter

Canvas text is not selectable, not copyable, not Ctrl+F-able, and invisible to screen readers.
The streaming panel is canvas because Pretext is the point; the transcript view is DOM and
doubles as the accessibility layer.

- `TranscriptStore`: append-only, both speakers, observable, **client-only and ephemeral** —
  lives for the session and is never sent to the BFF. Hosts wanting persistence subscribe and
  save it themselves.
- Optional transcript view: virtualized list, auto-scroll with pin-to-bottom, `aria-live` on
  the latest agent message, text selection, search.
- Add `packages/react` only now. `@jarvis-viz/react` contains the `useRef` + `useEffect`
  lifecycle wrapper and replaceable transcript view; React and React DOM are peer dependencies.
  The adapter imports only `@jarvis-viz/core`'s public entry point.

**Automated success:** transcript ordering is unit-tested under interleaved user/agent deltas;
the React package typechecks against its declared peer range; an import-boundary check finds no
core deep imports; mount/update/unmount tests prove one `VoiceViz` instance is disposed.

**Manual success:** transcript text can be selected, searched, and keyboard-navigated; a screen
reader announces the latest agent turn without replaying the full history; consumers can
replace the default transcript view without changing the canvas widget.

### Phase 6 — Bun BFF and distribution

`POST /session` mints an ephemeral token; the OpenAI key never reaches the browser —
mandatory, since an embedded widget runs on someone else's page by definition. The BFF is
**stateless**: one endpoint, no conversation storage, no retention policy.

**An embeddable widget backed by your key is an open wallet.** From day one, not v2: origin
allowlist, per-origin rate limiting, per-session budget caps, short token TTL.

Use **WebRTC** — browser ↔ OpenAI direct, BFF stays a small token endpoint, jitter buffering
and echo cancellation come free. Add a WebSocket relay only when a customer demands
server-side moderation; it puts you on the hook for bandwidth and PCM framing.

**Bun is the required BFF runtime.** Implement the single endpoint with `Bun.serve`, using
standard Fetch API `Request` and `Response` objects at the route boundary. Do not add Express,
Fastify, or a Node HTTP compatibility layer for this one-route service. Add `@types/bun` as a
server development dependency and include `"types": ["bun"]` in `server/tsconfig.json`.

The private `@jarvis-viz/server` package exposes these scripts:

```json
{
  "scripts": {
    "dev": "bun --watch run src/index.ts",
    "start": "bun run dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "bun build ./src/index.ts --target=bun --outdir=dist"
  }
}
```

`bunfig.toml` contains server-local runtime/test settings only. Secrets come from the deployment
environment and are read and validated once by `server/src/config.ts`; production does not
depend on a checked-in `.env` file. The Bun-targeted `dist/index.js` is the deployment entry
point, and CI/deployment run it with Bun—not Node.

The BFF requests **`gpt-realtime-2.1-mini`** for live sessions. This is the checked-in default
and the value documented in `server/.env.example`; `OPENAI_REALTIME_MODEL` remains an explicit
deployment override. Existing output-token and retained-context caps remain server-owned and do
not expand merely because the model supports larger limits.

The demo exposes two pre-connection controls. **Response timing** maps the three UI choices to
bounded reasoning effort, semantic-VAD eagerness, and input-transcription delay. **Speech speed**
maps to `audio.output.speed` within the narrower product range `0.75`-`1.25`. The BFF rejects
unknown timing modes and out-of-range rates before requesting a client secret. Input transcription
uses `gpt-realtime-whisper`, and the browser multiplies its analyser-gated agent transcript pace by
the selected speech speed so visible text continues to follow locally audible output. Transcription
is Mandarin-first while retaining Cantonese support: the BFF sends the accepted umbrella Chinese
language hint `zh`. `gpt-realtime-whisper` rejects the shared schema's multilingual `languages`
and `prompt` fields, so neither is sent. The timing presets use `low`, `medium`, and `high`
transcription delay so even **Fast** avoids the least accurate `minimal` setting. Browser pacing
releases CJK text by Unicode grapheme instead of waiting for spaces, and the streaming panel
recognizes CJK punctuation and batches long unspaced runs for incremental layout without clipping
characters.

Add the remaining end-state directories in this phase:

- `server/src/index.ts` constructs the `Bun.serve` listener and dispatches `POST /session`.
  It contains no token, guard, or provider business logic.
- `server/src/routes/session.ts` validates the request and delegates token creation to
  `providers/openai-session.ts`; the three `guards/` modules enforce origin, rate, and budget
  independently. The server never imports `packages/core` or stores transcript/session state.
- `packages/wc/src/voice-viz-element.ts` owns the custom-element lifecycle and mounts core into
  its Shadow DOM. `styles.ts` contains only shadow-local defaults.
- Package build/export metadata is finalized for publication, and the demo consumes built
  package entry points exactly as an external host would.

Then publish packages and embed documentation.

**Automated success:** all workspace packages typecheck, test, and build independently. The
server-specific checks run through its Bun-backed package scripts:

```bash
pnpm --filter @jarvis-viz/server typecheck
pnpm --filter @jarvis-viz/server test
pnpm --filter @jarvis-viz/server build
```

An integration test starts `Bun.serve` on an ephemeral port and exercises the real HTTP
boundary. BFF tests cover rejected origins, rate limits, budgets, expired tokens, malformed
requests, and provider failures. The architecture check rejects `bun.lock`, Node HTTP imports,
and browser-package imports from the server. Package `exports` maps reject deep imports, and a
package-artifact smoke test imports core, React, and WC from their packed tarballs.

**Manual success:** the custom element embeds in a scratch page with hostile global CSS and no
style leakage; a real short-TTL session connects through the BFF; the server retains no
conversation after disconnect; the bundled BFF starts and shuts down cleanly under the pinned
Bun runtime; published embed instructions work in both module and React examples.

---

## Verification

### Automated verification

- Run `pnpm check:boundaries && pnpm typecheck && pnpm test && pnpm build` at each phase; the
  root scripts aggregate all packages that exist at that phase. Every package extends
  `tsconfig.base.json`, preserving `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and
  `verbatimModuleSyntax`.
- Pure synthetic tests cover speech feature extraction against generated tone/noise, all state
  transitions including barge-in and error, append-stable wrapping, scroll anchoring across a
  width change, panel interaction, and transcript ordering under interleaved deltas.
- After Phase 1, `test ! -d src` proves the flat root source tree is gone. Import-boundary checks
  reject package deep imports, browser imports from `server/`, server imports from browser
  packages, renderer imports of transport implementations, and OpenAI event names outside
  `packages/core/src/transport/openai.ts`.
- Render tests use an instrumented canvas context to assert that every preset is clipped to
  `regions.viz` and that the text panel paints only inside `regions.panel`.
- Phase 6 packs each public package and imports it from the produced tarball, catching exports,
  declaration, peer-dependency, and accidental source-path errors that workspace linking hides.
- Phase 6 also runs `bun --version`, the server's typecheck/test/build scripts, and an HTTP smoke
  test against the Bun-targeted `dist/index.js`. Only `pnpm-lock.yaml` may exist; neither root
  nor `server/` may contain `bun.lock` or `bun.lockb`.

### Manual verification

- **Performance:** profile a 200-word response. Frame time stays below 16 ms;
  `prepareWithSegments` calls scale with words rather than tokens; 100+ line scrollback holds
  60fps; idle CPU/GPU use remains suitable for an embedded widget.
- **Responsive:** render the widget at 320×200, 800×600, and full-bleed simultaneously. Verify
  placement flips at the breakpoint, device-pixel-ratio changes remain sharp, and no preset or
  panel uses viewport coordinates.
- **Lifecycle:** repeatedly mount, connect, disconnect, and unmount. Confirm there is one RAF,
  one resize observer, no duplicate transport listeners, and no surviving audio nodes.
- **Embedding:** load the core, React adapter, and web component into scratch host pages with
  aggressive global CSS. Confirm no style leakage in either direction.
- **Live:** run a real GPT-Realtime session with barge-in mid-response, a 2+ minute conversation
  for leak/cache-growth checks, network drop/reconnect, and scrollback followed by re-pin while
  text is still streaming.
- **Accessibility:** keyboard-navigate and search the transcript, select/copy its text, and
  confirm a screen reader announces new agent turns without exposing canvas text as the sole
  accessible representation.

### Implementation evidence — 2026-08-13

- [x] `pnpm verify` passes: boundary checks, strict typechecking, 79 tests (55 core, 5 React,
  1 web component, 1 demo, 17 Bun server), all package/demo/server builds, and the packed-package
  consumer smoke test.
- [x] The root `src/` tree and music/lyrics playback assets are gone. The boundary check rejects
  deep imports, browser/server dependency leaks, Node HTTP use, raw OpenAI events outside the
  transport adapter, and Bun lockfiles.
- [x] All five registered presets execute through the clipped Canvas 2D pass. Theme tests cover
  fixed/cycle/state modes, the four retained multi-hue palettes, text motion, and numeric bounds.
- [x] Streaming-panel, transcript, adapter lifecycle, state, audio, transport, layout, origin,
  rate, budget, provider, and real Bun HTTP-boundary tests pass.
- [x] Core, React, and WC packed tarballs import from an isolated consumer. Their declarations
  typecheck, and the core exports map rejects a deep import.
- [x] The Bun 1.3.14 production bundle starts and stops cleanly. `/health` returns the Bun
  runtime marker, and an untrusted-origin `/session` request returns 403.
- [x] `.github/workflows/verify.yml` installs Bun from `.bun-version`, pins pnpm 11.17.0, and
  runs the same `pnpm verify` command used locally. The BFF uses Bun for serving, tests, builds,
  and production execution; pnpm remains the sole installer and lockfile owner.
- [x] `CI=true pnpm install --frozen-lockfile` succeeds from the committed lockfile. The only
  dependency build script, esbuild's platform setup, is explicitly allowed in
  `pnpm-workspace.yaml`; no interactive build approval is required in CI.
- [x] The first-party demo, React adapter, web component, and docs use the split
  `new VoiceViz(options)` then `mount(container)` lifecycle. The legacy constructor overload is
  retained only as a deprecated compatibility path.
- [x] Remote agent media is attached to the muted hidden `<audio>` element required for stable
  analyser delivery, while the Web Audio graph monitors the analyser to the destination so the
  agent remains audible. Teardown tests cover audio-graph disconnects and repeated lifecycle use.
- [x] Programmatic desktop/mobile demo inspection found no console errors or horizontal
  overflow, verified all three host sizes, live/simulation controls, one transcript live
  region, bounded transcript DOM, and panel/theme/preset switching.
- [x] The built `/embed.html` harness loads `@jarvis-viz/wc` beneath hostile global canvas and
  typography rules. Real-browser inspection confirms one 800×600 visible shadow canvas, reset
  internal typography, no selector leakage into the shadow tree, no overflow, and no console
  warnings/errors.
- [x] A real API-backed browser session reaches `Connected · idle` through the Bun BFF with
  browser-granted microphone capture. Live verification also confirmed that the ephemeral-token
  `/v1/realtime/calls` request must send the SDP offer as `application/sdp`; the transport now
  waits for ICE, peer, or data-channel readiness and fails explicitly after a 20-second timeout.
- [x] The demo's primary-session control is a connection toggle: it prevents duplicate attempts,
  changes from **Connect primary** to **Disconnect primary** after WebRTC readiness, locks the
  endpoint while active, and restores the disconnected state after teardown. A real browser cycle
  through the Bun BFF verified both transitions.
- [x] The Bun BFF defaults live sessions to `gpt-realtime-2.1-mini`; the local server environment,
  sample environment, configuration test, provider contract test, and plan use the same model ID.
  A real post-restart browser session reached `Connected · idle` with that configuration.
- [x] The live demo exposes accessible **Response timing** and **Speech speed** controls. Their
  preferences cross the provider-neutral transport boundary, are range/enum validated by Bun,
  map to reasoning effort, semantic-VAD eagerness, `gpt-realtime-whisper` delay, and output audio
  speed, and lock during an active connection. A real browser cycle selected **Fast** and
  **1.15x**, confirmed the synchronized rate readout, reached `Connected · idle`, verified the
  locked settings and **Disconnect primary** state, then returned to an editable disconnected
  state without losing the selected preferences.
- [x] Audio-transcript deltas are buffered behind locally audible speech instead of being painted
  at provider delivery speed. Six focused synchronization tests cover audible gating, paced word
  and CJK-grapheme release, final-silence flushing, no-audio fallback, and interruption; browser
  simulation shows the transcript advancing in partial spoken phrases before completing when
  audio ends.
- [x] Mandarin-first transcription sends the `zh` umbrella language hint accepted by
  `gpt-realtime-whisper`, retaining Cantonese within the same Chinese session. Live schema probes
  confirmed that singular `zh`, `cmn`, and `yue` are accepted while this model rejects `languages`
  and `prompt`; the product uses `zh` to avoid forcing one spoken Chinese variety. Chinese
  regression tests verify that unspaced transcript pacing advances during audio and that
  incremental panel layout preserves every character across CJK punctuation and wrapped lines.
- [ ] Run a real short-lived GPT-Realtime session with microphone permission and verify that
  the remote track drives the analyser, only agent audio is visualized, all five states appear,
  and mid-response barge-in works.
- [ ] Profile a 200-word response, 100+ panel lines, and a 2+ minute conversation on target
  devices; confirm the 16 ms frame budget, idle power, cache growth, and reconnect behavior.
- [ ] Perform human keyboard, selection/copy, and screen-reader checks.

The unchecked items are deliberately not inferred from synthetic or browser-automation tests.
They require a real API key/session, user microphone permission, target-device profiling, or
human assistive-technology judgment.

---

## Risks

- **Phase 0 is a genuine gate.** If the WebRTC → analyser path can't produce usable spectrum
  data at 24 kHz, the Phase 4 visual assumptions need rethinking before any of it is built.
- **Phase 3 is the hardest work** and has no precedent in the current code — lyric layout was
  always finalized text, never a growing scrollback. Canvas scroll physics (wheel, drag,
  momentum, scrollbar, re-anchoring) is the part most likely to be underestimated.
- **Test coverage drops during migration.** Rebuild it with each module owner rather than
  postponing it: regions/audio in Phase 1, state in Phase 2, streaming wrap/input in Phase 3,
  renderer/theme in Phase 4, and transcript/adapters in Phase 5.
- **Preset surface can sprawl.** Keeping `Visualizer` internal in v1 is the mitigation — it
  buys room to change `VizFrame` once real presets expose its gaps.
- **Bun is a deployment requirement, not a local convenience.** Pin the same Bun release in
  development, CI, and production; exercise dependencies under Bun in tests and do not silently
  fall back to Node when a package uses incompatible runtime behavior.
