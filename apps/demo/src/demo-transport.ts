import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeTransport, VoiceFeatures, VoiceFeatureSource } from "@jarvis-viz/core";

const SAMPLE_TURNS = [
  ["Map the strongest frequencies in my voice.", "The center ring follows level and onset. The surrounding field tracks spectral shape in real time."],
  ["What changes when I interrupt?", "The state machine marks the interruption, releases the previous motion, and immediately returns focus to your speech."],
] as const;

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export class DemoVoiceFeatureSource implements VoiceFeatureSource {
  readonly #frequencyData = new Uint8Array(256);
  readonly #waveformData = new Uint8Array(512);
  #agentSpeaking = false;
  #previousLevel = 0;

  setAgentSpeaking(speaking: boolean): void {
    this.#agentSpeaking = speaking;
  }

  sample(now: number): VoiceFeatures {
    const phase = now / 1_000;
    const level = this.#agentSpeaking ? 0.38 + Math.sin(phase * 7.1) * 0.12 + Math.sin(phase * 17.3) * 0.06 : 0.015;
    const onset = Math.max(0, (level - this.#previousLevel) * 5);
    this.#previousLevel = level;
    for (let index = 0; index < this.#frequencyData.length; index += 1) {
      const voiceShape = Math.exp(-Math.pow((index - 42) / 34, 2));
      const articulation = (Math.sin(index * 0.19 + phase * 11) + 1) * 0.5;
      this.#frequencyData[index] = clampByte(this.#agentSpeaking ? 16 + voiceShape * (88 + articulation * 110) * level : 2 + voiceShape * 3);
    }
    for (let index = 0; index < this.#waveformData.length; index += 1) {
      const speech = Math.sin(index * 0.18 + phase * 29) * 0.68 + Math.sin(index * 0.047 + phase * 12) * 0.32;
      this.#waveformData[index] = clampByte(128 + speech * level * 104);
    }
    return {
      level,
      onset,
      silenceMs: this.#agentSpeaking ? 0 : 1_000,
      centroid: this.#agentSpeaking ? 0.34 + Math.sin(phase * 2.1) * 0.04 : 0.08,
      voiced: this.#agentSpeaking,
      frequencyData: this.#frequencyData,
      waveformData: this.#waveformData,
    };
  }

  dispose(): void {
    this.#agentSpeaking = false;
  }
}

export class DemoTransport implements RealtimeTransport {
  #listeners = new Set<RealtimeEventListener>();
  #timers = new Set<number>();
  #connected = false;
  #turn = 0;

  constructor(readonly signal = new DemoVoiceFeatureSource()) {}

  get connected(): boolean { return this.#connected; }
  get agentAudio(): MediaStreamTrack | null { return null; }

  subscribe(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.disconnect();
    this.#connected = true;
    this.signal.setAgentSpeaking(false);
    this.#emit({ type: "connected" });
    this.#scheduleTurn(180);
  }

  disconnect(): void {
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers.clear();
    const wasConnected = this.#connected;
    this.#connected = false;
    this.signal.setAgentSpeaking(false);
    if (wasConnected) this.#emit({ type: "disconnected" });
  }

  #scheduleTurn(delay: number): void {
    this.#later(delay, () => {
      const [user, agent] = SAMPLE_TURNS[this.#turn % SAMPLE_TURNS.length] ?? SAMPLE_TURNS[0];
      this.#turn += 1;
      this.signal.setAgentSpeaking(false);
      this.#emit({ type: "user-speech-started" });
      this.#later(650, () => {
        this.#emit({ type: "user-speech-stopped" });
        this.#emit({ type: "user-text", text: user });
        this.#later(460, () => this.#stream(agent));
      });
    });
  }

  #stream(text: string): void {
    this.signal.setAgentSpeaking(true);
    this.#emit({ type: "agent-audio-started" });
    const chunks = text.match(/\S+\s*/g) ?? [text];
    chunks.forEach((chunk, index) => this.#later(index * 135, () => this.#emit({ type: "agent-text-delta", delta: chunk, audioSynchronized: true })));
    this.#later(chunks.length * 135 + 120, () => {
      this.signal.setAgentSpeaking(false);
      this.#emit({ type: "agent-text-done", text, audioSynchronized: true });
      this.#emit({ type: "response-done" });
      if (this.#connected) this.#scheduleTurn(1_600);
    });
  }

  #later(delay: number, callback: () => void): void {
    const timer = window.setTimeout(() => { this.#timers.delete(timer); if (this.#connected) callback(); }, delay);
    this.#timers.add(timer);
  }

  #emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
