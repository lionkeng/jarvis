import type { AudioFrame, VoiceFeatures } from "./types.js";

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export class SpeechFeatureExtractor {
  #level = 0;
  #silenceMs = 0;
  #lastSampleAt = 0;

  read(frame: AudioFrame, now = performance.now()): VoiceFeatures {
    const dt = this.#lastSampleAt === 0 ? 1 / 60 : clamp((now - this.#lastSampleAt) / 1000, 1 / 240, 0.2);
    this.#lastSampleAt = now;

    let sumSquares = 0;
    for (const value of frame.waveformData) {
      const sample = (value - 128) / 128;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(frame.waveformData.length, 1));
    const targetLevel = clamp(rms * 3.4);
    const previous = this.#level;
    const smoothing = 1 - Math.exp(-dt * (targetLevel > previous ? 26 : 9));
    this.#level += (targetLevel - previous) * smoothing;
    const onset = clamp((this.#level - previous) * 11);

    let weighted = 0;
    let magnitude = 0;
    let voiceEnergy = 0;
    let highEnergy = 0;
    const nyquist = frame.sampleRate / 2;
    const binWidth = nyquist / Math.max(frame.frequencyData.length, 1);
    for (let index = 0; index < frame.frequencyData.length; index += 1) {
      const energy = (frame.frequencyData[index] ?? 0) / 255;
      const hz = index * binWidth;
      weighted += hz * energy;
      magnitude += energy;
      if (hz >= 85 && hz <= 3_600) voiceEnergy += energy;
      if (hz > 3_600) highEnergy += energy;
    }

    const centroidHz = magnitude > 0 ? weighted / magnitude : 0;
    const centroid = clamp(centroidHz / 6_000);
    const voicedConfidence = clamp((voiceEnergy / Math.max(voiceEnergy + highEnergy, 0.001)) * this.#level * 1.6);
    if (this.#level < 0.035) this.#silenceMs += dt * 1_000;
    else this.#silenceMs = 0;

    return {
      level: this.#level,
      onset,
      silenceMs: this.#silenceMs,
      centroid,
      voiced: voicedConfidence > 0.1,
      frequencyData: frame.frequencyData,
      waveformData: frame.waveformData,
    };
  }
}
