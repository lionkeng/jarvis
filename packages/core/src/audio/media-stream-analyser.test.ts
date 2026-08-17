import { describe, expect, it, vi } from "vitest";
import { MediaStreamAnalyser } from "./media-stream-analyser.js";

describe("MediaStreamAnalyser", () => {
  it("connects the remote stream to analysis and audible monitoring, then disconnects it", async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = {
      connect: vi.fn(), disconnect: vi.fn(), getByteFrequencyData: vi.fn(), getByteTimeDomainData: vi.fn(),
      fftSize: 0, frequencyBinCount: 32, smoothingTimeConstant: 0,
    };
    const destination = {};
    const context = {
      createAnalyser: () => analyser,
      createMediaStreamSource: () => source,
      destination,
      resume: vi.fn(),
      close: vi.fn(),
      state: "running",
      sampleRate: 24_000,
    } as unknown as AudioContext;

    const monitor = new MediaStreamAnalyser({} as MediaStream, { audioContext: context });
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(destination);
    await monitor.dispose();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(analyser.disconnect).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("can disable audible monitoring", () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = {
      connect: vi.fn(), disconnect: vi.fn(), getByteFrequencyData: vi.fn(), getByteTimeDomainData: vi.fn(),
      fftSize: 0, frequencyBinCount: 32, smoothingTimeConstant: 0,
    };
    const context = {
      createAnalyser: () => analyser,
      createMediaStreamSource: () => source,
      destination: {}, resume: vi.fn(), close: vi.fn(), state: "running", sampleRate: 24_000,
    } as unknown as AudioContext;

    new MediaStreamAnalyser({} as MediaStream, { audioContext: context, monitor: false });
    expect(analyser.connect).not.toHaveBeenCalled();
  });
});
