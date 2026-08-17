import { SpeechFeatureExtractor } from "./speech-features.js";
import type { VoiceFeatures, VoiceFeatureSource } from "./types.js";

export interface MediaStreamAnalyserOptions {
  fftSize?: number;
  smoothingTimeConstant?: number;
  audioContext?: AudioContext;
  monitor?: boolean;
}

export class MediaStreamAnalyser implements VoiceFeatureSource {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly source: MediaStreamAudioSourceNode;
  readonly #frequencyData: Uint8Array<ArrayBuffer>;
  readonly #waveformData: Uint8Array<ArrayBuffer>;
  readonly #extractor = new SpeechFeatureExtractor();
  readonly #ownsContext: boolean;

  constructor(stream: MediaStream, options: MediaStreamAnalyserOptions = {}) {
    this.#ownsContext = options.audioContext === undefined;
    this.context = options.audioContext ?? new AudioContext({ latencyHint: "interactive" });
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = options.fftSize ?? 2048;
    this.analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.78;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    if (options.monitor ?? true) this.analyser.connect(this.context.destination);
    this.#frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.#waveformData = new Uint8Array(this.analyser.fftSize);
    void this.context.resume();
  }

  sample(now: number): VoiceFeatures {
    this.analyser.getByteFrequencyData(this.#frequencyData);
    this.analyser.getByteTimeDomainData(this.#waveformData);
    return this.#extractor.read({
      frequencyData: this.#frequencyData,
      waveformData: this.#waveformData,
      sampleRate: this.context.sampleRate,
      fftSize: this.analyser.fftSize,
    }, now);
  }

  async dispose(): Promise<void> {
    this.source.disconnect();
    this.analyser.disconnect();
    if (this.#ownsContext && this.context.state !== "closed") await this.context.close();
  }
}
