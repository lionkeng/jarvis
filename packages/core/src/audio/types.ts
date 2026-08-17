export interface VoiceFeatures {
  level: number;
  onset: number;
  silenceMs: number;
  centroid: number;
  voiced: boolean;
  frequencyData: Uint8Array;
  waveformData: Uint8Array;
}

export interface AudioFrame {
  frequencyData: Uint8Array;
  waveformData: Uint8Array;
  sampleRate: number;
  fftSize: number;
}

export interface VoiceFeatureSource {
  sample(now: number): VoiceFeatures;
  dispose(): void | Promise<void>;
}
