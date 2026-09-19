import { themes, VoiceViz, type PanelPlacement, type PresetName, type RealtimeTransport, type ThemeName } from "@jarvis-viz/core";
import { voiceVizElementStyles } from "./styles.js";

export class VoiceVizElement extends HTMLElement {
  static observedAttributes = ["presets", "theme", "panel-placement"];
  readonly #root: ShadowRoot;
  readonly #mount: HTMLDivElement;
  #instance: VoiceViz | undefined;
  #transport: RealtimeTransport | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = voiceVizElementStyles;
    this.#mount = document.createElement("div");
    this.#mount.className = "mount";
    this.#root.append(style, this.#mount);
  }

  connectedCallback(): void {
    if (!this.#instance) {
      this.#instance = new VoiceViz(this.#options());
      this.#instance.mount(this.#mount);
    }
    if (this.hasAttribute("auto-connect") && this.tokenEndpoint) void this.connect();
  }

  disconnectedCallback(): void {
    this.#instance?.unmount();
    this.#instance = undefined;
  }

  attributeChangedCallback(): void {
    if (!this.#instance) return;
    this.#instance.setPresets(this.#presets());
    this.#instance.setTheme(this.theme);
    this.#instance.setPanelPlacement(this.panelPlacement);
  }

  get tokenEndpoint(): string {
    return this.getAttribute("token-endpoint") ?? "/session";
  }

  set tokenEndpoint(value: string) {
    this.setAttribute("token-endpoint", value);
  }

  get theme(): ThemeName {
    const value = this.getAttribute("theme");
    return value && Object.prototype.hasOwnProperty.call(themes, value) ? value as ThemeName : "cyan";
  }

  get panelPlacement(): PanelPlacement {
    const value = this.getAttribute("panel-placement");
    return value === "bottom" || value === "side" ? value : "auto";
  }

  get transport(): RealtimeTransport | undefined {
    return this.#transport;
  }

  set transport(value: RealtimeTransport | undefined) {
    if (value === this.#transport) return;
    if (this.#instance?.connected) throw new Error("jarvis-voice-viz cannot swap transport during a live session: call disconnect() first");
    this.#transport = value;
    if (!this.#instance) return;
    this.#instance.unmount();
    this.#instance = new VoiceViz(this.#options());
    this.#instance.mount(this.#mount);
  }

  async connect(): Promise<void> {
    if (!this.#instance) this.connectedCallback();
    await this.#instance?.connect(this.tokenEndpoint);
  }

  async disconnect(): Promise<void> {
    await this.#instance?.disconnect();
  }

  #presets(): PresetName[] {
    const allowed = new Set<PresetName>(["bars", "waveform", "ring", "particles", "hud"]);
    const parsed = (this.getAttribute("presets") ?? "bars,waveform,ring,particles,hud").split(",").map((value) => value.trim()).filter((value): value is PresetName => allowed.has(value as PresetName));
    return parsed.length ? parsed : ["ring"];
  }

  #options() {
    return { presets: this.#presets(), theme: this.theme, panelPlacement: this.panelPlacement, ...(this.#transport ? { transport: this.#transport } : {}) };
  }
}

export function defineVoiceVizElement(tagName = "jarvis-voice-viz"): void {
  if (!customElements.get(tagName)) customElements.define(tagName, VoiceVizElement);
}
