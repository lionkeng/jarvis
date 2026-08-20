import { describe, expect, it } from "vitest";
import type { RealtimeToolResult } from "@jarvis-viz/core";
import { DemoTransport, DemoVoiceFeatureSource } from "./demo-transport.js";

describe("DemoVoiceFeatureSource", () => {
  it("keeps user/idle periods quiet and drives a speech-shaped remote-agent fixture", () => {
    const source = new DemoVoiceFeatureSource();
    const idle = source.sample(1_000);
    const idleFrequencyPeak = Math.max(...idle.frequencyData);
    const idleWaveform = idle.waveformData.slice();
    source.setAgentSpeaking(true);
    const speaking = source.sample(1_100);

    expect(idle.level).toBeLessThan(0.02);
    expect(idle.silenceMs).toBe(1_000);
    expect(speaking.level).toBeGreaterThan(0.2);
    expect(speaking.silenceMs).toBe(0);
    expect(Math.max(...speaking.frequencyData)).toBeGreaterThan(idleFrequencyPeak);
    expect(speaking.waveformData).not.toEqual(idleWaveform);
  });
});

describe("DemoTransport", () => {
  it("records submitted tool results without emitting provider event names", () => {
    const transport = new DemoTransport();
    const result: RealtimeToolResult = { callId: "call_1", output: "{\"ok\":true}", followUp: "brief-acknowledgement" };
    transport.submitToolResult(result);
    expect(transport.submittedToolResults).toEqual([result]);
  });
});
