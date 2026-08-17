import { describe, expect, it } from "vitest";
import { SpeechFeatureExtractor } from "./speech-features.js";

function frame(amplitude: number, voiceBin = 15) {
  const waveformData = new Uint8Array(256);
  const frequencyData = new Uint8Array(128);
  for (let index = 0; index < waveformData.length; index += 1) {
    waveformData[index] = 128 + Math.round(Math.sin(index * 0.2) * amplitude);
  }
  frequencyData[voiceBin] = amplitude * 2;
  return { waveformData, frequencyData, sampleRate: 24_000, fftSize: 256 };
}

describe("SpeechFeatureExtractor", () => {
  it("detects an onset and smooths the following release", () => {
    const extractor = new SpeechFeatureExtractor();
    extractor.read(frame(0), 10);
    const attack = extractor.read(frame(90), 26);
    const release = extractor.read(frame(0), 42);
    expect(attack.onset).toBeGreaterThan(0.2);
    expect(release.level).toBeGreaterThan(0);
    expect(release.level).toBeLessThan(attack.level);
  });

  it("reports voiced energy for speech-band bins", () => {
    const features = new SpeechFeatureExtractor().read(frame(100), 16);
    expect(features.voiced).toBe(true);
    expect(features.centroid).toBeGreaterThan(0);
  });

  it("tracks continuous silence in milliseconds", () => {
    const extractor = new SpeechFeatureExtractor();
    extractor.read(frame(0), 10);
    const silent = extractor.read(frame(0), 110);
    expect(silent.silenceMs).toBeGreaterThanOrEqual(100);
    expect(extractor.read(frame(100), 126).silenceMs).toBe(0);
  });
});
