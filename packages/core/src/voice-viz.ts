import { IdleFeatureSource } from "./audio/idle-features.js";
import { MediaStreamAnalyser } from "./audio/media-stream-analyser.js";
import type { VoiceFeatureSource } from "./audio/types.js";
import { computeRegions } from "./layout/regions.js";
import type { PanelPlacement, Regions } from "./layout/types.js";
import { CanvasRenderer } from "./render/canvas-renderer.js";
import { PresetRegistry } from "./render/registry.js";
import { resolveTheme, themeForFrame, type Theme, type ThemeInput } from "./render/theme.js";
import type { PresetName } from "./render/types.js";
import { VoiceStateMachine } from "./state/state-machine.js";
import type { AgentState, VoiceSessionEvent } from "./state/types.js";
import { PanelInputController } from "./text/panel-input.js";
import { PretextLayout } from "./text/pretext-layout.js";
import { AudioTextSynchronizer } from "./text/audio-text-sync.js";
import { StreamingTextPanel } from "./text/streaming-panel.js";
import { TranscriptStore } from "./transcript/store.js";
import type { TranscriptSnapshot } from "./transcript/types.js";
import { OpenAIRealtimeTransport } from "./transport/openai.js";
import type { NormalizedRealtimeEvent, RealtimeSessionPreferences, RealtimeToolCall, RealtimeToolResult, RealtimeTransport } from "./transport/types.js";

export interface VoiceVizOptions {
  presets?: readonly PresetName[];
  theme?: ThemeInput;
  panelPlacement?: PanelPlacement;
  panelBreakpoint?: number;
  locale?: string;
  transport?: RealtimeTransport;
  featureSource?: VoiceFeatureSource;
  reducedMotion?: boolean;
}

export interface VoiceVizEventMap {
  statechange: { state: AgentState; previous: AgentState };
  transcriptchange: TranscriptSnapshot;
  toolcall: RealtimeToolCall;
  error: { error: Error };
}

export type VoiceVizEventName = keyof VoiceVizEventMap;
export type VoiceVizEventListener<K extends VoiceVizEventName> = (event: VoiceVizEventMap[K]) => void;

export class VoiceViz {
  readonly transcript = new TranscriptStore();
  readonly #registry = new PresetRegistry();
  readonly #state = new VoiceStateMachine();
  readonly #panel: StreamingTextPanel;
  readonly #audioText: AudioTextSynchronizer;
  readonly #transport: RealtimeTransport;
  readonly #featureSource: VoiceFeatureSource | undefined;
  readonly #idleFeatureSource = new IdleFeatureSource();
  readonly #listeners = new Map<VoiceVizEventName, Set<(value: never) => void>>();
  readonly #unsubscribeTransport: () => void;
  readonly #unsubscribeTranscript: () => void;
  #mount: HTMLElement | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #renderer: CanvasRenderer | undefined;
  #panelInput: PanelInputController | undefined;
  #presetNames: readonly PresetName[];
  #theme: Theme;
  #placement: PanelPlacement;
  #breakpoint: number;
  #regions: Regions;
  #analyser: MediaStreamAnalyser | undefined;
  #audio: HTMLAudioElement | undefined;
  #reducedMotion: boolean;
  #unmounted = false;

  constructor(options?: VoiceVizOptions);
  /** @deprecated Pass options to the constructor and call mount(container). */
  constructor(mount: HTMLElement, options?: VoiceVizOptions);
  constructor(optionsOrMount: VoiceVizOptions | HTMLElement = {}, legacyOptions: VoiceVizOptions = {}) {
    let mount: HTMLElement | undefined;
    let options: VoiceVizOptions;
    if (isMountElement(optionsOrMount)) {
      mount = optionsOrMount;
      options = legacyOptions;
    } else {
      options = optionsOrMount;
    }
    this.#theme = resolveTheme(options.theme);
    this.#placement = options.panelPlacement ?? "auto";
    this.#breakpoint = options.panelBreakpoint ?? 640;
    this.#presetNames = options.presets ?? ["bars", "waveform", "ring", "particles", "hud"];
    this.#reducedMotion = options.reducedMotion ?? globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const textLayout = options.locale ? new PretextLayout(undefined, { locale: options.locale }) : new PretextLayout();
    this.#panel = new StreamingTextPanel(textLayout);
    this.#audioText = new AudioTextSynchronizer((delta, now) => this.#appendAgentText(delta, now));
    this.#transport = options.transport ?? new OpenAIRealtimeTransport();
    this.#featureSource = options.featureSource;
    this.#regions = computeRegions(1, 1, { placement: this.#placement, breakpoint: this.#breakpoint });
    this.#unsubscribeTransport = this.#transport.subscribe((event) => this.#handleTransport(event));
    this.#unsubscribeTranscript = this.transcript.subscribe((snapshot) => this.#emit("transcriptchange", snapshot));
    if (mount) this.mount(mount);
  }

  get canvas(): HTMLCanvasElement {
    this.#assertMounted();
    return this.#canvas!;
  }

  mount(container: HTMLElement): void {
    if (this.#unmounted) throw new Error("VoiceViz has been unmounted");
    if (this.#renderer) throw new Error("VoiceViz is already mounted");
    this.#mount = container;
    const canvas = document.createElement("canvas");
    canvas.dataset.voiceViz = "";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;background:#070b0d";
    container.append(canvas);
    this.#canvas = canvas;
    const renderer = new CanvasRenderer(canvas, container);
    this.#renderer = renderer;
    renderer.setPresets(this.#registry.create(this.#presetNames));
    this.#regions = computeRegions(renderer.size.width, renderer.size.height, { placement: this.#placement, breakpoint: this.#breakpoint });
    this.#panelInput = new PanelInputController(canvas, this.#panel, () => this.#regions.panel);
    renderer.start((now) => {
      const size = renderer.size;
      this.#regions = computeRegions(size.width, size.height, { placement: this.#placement, breakpoint: this.#breakpoint });
      const features = this.#analyser?.sample(now) ?? this.#featureSource?.sample(now) ?? this.#idleFeatureSource.sample(now);
      const sync = this.#audioText.tick(now, features.voiced || features.level >= 0.035);
      if (sync.audioStarted) this.#dispatch({ type: "agent-audio-started" });
      if (sync.completed) this.#completeAgentResponse(now);
      const frameTheme = themeForFrame(this.#theme, this.#state.snapshot.state, now);
      return {
        state: this.#state.snapshot.state,
        stateAge: Math.max(0, now - this.#state.snapshot.changedAt) / 1_000,
        features,
        regions: this.#regions,
        theme: frameTheme,
        reducedMotion: this.#reducedMotion,
        paintPanel: ({ context }) => this.#panel.paint(context, this.#regions.panel, now, {
          foreground: frameTheme.foreground,
          muted: frameTheme.muted,
          accent: frameTheme.accent,
          surface: frameTheme.surface,
          state: this.#state.snapshot.state,
          features,
          reducedMotion: this.#reducedMotion,
          textMotion: frameTheme.textMotion,
        }),
      };
    });
  }

  get state(): AgentState {
    return this.#state.snapshot.state;
  }

  get connected(): boolean {
    return this.#transport.connected;
  }

  async connect(tokenEndpoint: string, preferences?: RealtimeSessionPreferences): Promise<void> {
    this.#assertMounted();
    this.#dispatch({ type: "connect" });
    await this.#transport.connect(tokenEndpoint, preferences);
  }

  disconnect(): void {
    this.#transport.disconnect();
    this.#audioText.interrupt();
    this.#detachAudio();
    this.#dispatch({ type: "disconnect" });
  }

  setTheme(theme: ThemeInput): void {
    this.#assertMounted();
    if (typeof theme === "string") {
      this.#theme = resolveTheme(theme);
      return;
    }
    const palette = theme.palette ?? (theme.accent ? [theme.accent, ...this.#theme.palette.slice(1)] : this.#theme.palette);
    this.#theme = resolveTheme({ ...this.#theme, ...theme, palette });
  }

  setPresets(presets: readonly PresetName[]): void {
    this.#assertMounted();
    this.#presetNames = presets;
    this.#renderer!.setPresets(this.#registry.create(presets));
  }

  setPanelPlacement(placement: PanelPlacement): void {
    this.#assertMounted();
    this.#placement = placement;
  }

  setTranscriptPace(multiplier: number): void {
    this.#audioText.setRateMultiplier(multiplier);
  }

  submitToolResult(result: RealtimeToolResult): void {
    this.#transport.submitToolResult(result);
  }

  on<K extends VoiceVizEventName>(name: K, listener: VoiceVizEventListener<K>): () => void {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener as (value: never) => void);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener as (value: never) => void);
  }

  unmount(): void {
    if (this.#unmounted) return;
    this.#unmounted = true;
    this.#transport.disconnect();
    this.#audioText.interrupt();
    this.#unsubscribeTransport();
    this.#unsubscribeTranscript();
    this.#detachAudio();
    void this.#featureSource?.dispose();
    this.#panelInput?.dispose();
    this.#renderer?.dispose();
    this.#canvas?.remove();
    this.#panelInput = undefined;
    this.#renderer = undefined;
    this.#canvas = undefined;
    this.#mount = undefined;
    this.#listeners.clear();
  }

  #handleTransport(event: NormalizedRealtimeEvent): void {
    const now = performance.now();
    switch (event.type) {
      case "connected":
        this.#dispatch({ type: "connected" });
        break;
      case "disconnected":
        this.#audioText.interrupt();
        this.#panel.finish(now);
        this.transcript.complete("agent", "interrupted", now);
        this.#dispatch({ type: "disconnect" });
        break;
      case "user-speech-started":
        if (this.#audioText.interrupt() || this.#state.snapshot.state === "speaking") {
          this.#panel.finish(now);
          this.transcript.complete("agent", "interrupted", now);
        }
        this.#dispatch({ type: "user-speech-started" });
        break;
      case "user-speech-stopped":
        this.#dispatch({ type: "user-speech-stopped" });
        break;
      case "user-text":
        this.transcript.appendMessage("user", event.text, now);
        break;
      case "agent-audio-started":
        this.#dispatch({ type: "agent-audio-started" });
        break;
      case "agent-audio-stopped":
        if (!this.#audioText.active) this.#dispatch({ type: "agent-audio-stopped" });
        break;
      case "agent-text-delta":
        if (event.audioSynchronized) this.#audioText.enqueue(event.delta, now);
        else this.#appendAgentText(event.delta, now);
        break;
      case "agent-text-done":
        if (event.audioSynchronized) this.#audioText.finish(event.text, now);
        else {
          this.#appendMissingAgentText(event.text, now);
          this.#panel.finish(now);
          this.transcript.complete("agent", "complete", now);
        }
        break;
      case "response-done":
        if (this.#audioText.active) this.#audioText.finish(undefined, now);
        else this.#completeAgentResponse(now);
        break;
      case "agent-track":
        this.#attachAudio(event.stream);
        break;
      case "tool-call":
        this.#emit("toolcall", event.call);
        break;
      case "error":
        this.#audioText.interrupt();
        this.#panel.finish(now);
        this.transcript.complete("agent", "interrupted", now);
        this.#dispatch({ type: "fail", error: event.error });
        this.#emit("error", { error: event.error });
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  #attachAudio(stream: MediaStream): void {
    this.#detachAudio();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.muted = true;
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    audio.srcObject = stream;
    this.#mount!.append(audio);
    void audio.play().catch(() => undefined);
    this.#audio = audio;
    this.#analyser = new MediaStreamAnalyser(stream);
  }

  #appendMissingAgentText(finalText: string | undefined, now: number): void {
    if (!finalText) return;
    const latest = this.transcript.getSnapshot().messages.at(-1);
    if (latest?.role === "agent" && latest.status === "streaming") {
      if (finalText.startsWith(latest.text)) {
        const missing = finalText.slice(latest.text.length);
        if (missing) {
          this.#panel.append(missing, now);
          this.transcript.appendDelta("agent", missing, now);
        }
      }
      return;
    }
    this.#panel.append(finalText, now);
    this.transcript.appendDelta("agent", finalText, now);
  }

  #appendAgentText(delta: string, now: number): void {
    this.#panel.append(delta, now);
    this.transcript.appendDelta("agent", delta, now);
  }

  #completeAgentResponse(now: number): void {
    this.#panel.finish(now);
    this.transcript.complete("agent", "complete", now);
    this.#dispatch({ type: "response-done" });
  }

  #detachAudio(): void {
    void this.#analyser?.dispose();
    this.#analyser = undefined;
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.srcObject = null;
      this.#audio.remove();
      this.#audio = undefined;
    }
  }

  #dispatch(event: VoiceSessionEvent): void {
    const previous = this.#state.snapshot.state;
    const snapshot = this.#state.dispatch(event);
    if (snapshot.state !== previous) this.#emit("statechange", { state: snapshot.state, previous });
  }

  #emit<K extends VoiceVizEventName>(name: K, value: VoiceVizEventMap[K]): void {
    for (const listener of this.#listeners.get(name) ?? []) listener(value as never);
  }

  #assertMounted(): void {
    if (this.#unmounted) throw new Error("VoiceViz has been unmounted");
    if (!this.#renderer || !this.#mount || !this.#canvas) throw new Error("VoiceViz has not been mounted");
  }
}

function isMountElement(value: VoiceVizOptions | HTMLElement): value is HTMLElement {
  return typeof value === "object" && value !== null && "ownerDocument" in value && "append" in value;
}
