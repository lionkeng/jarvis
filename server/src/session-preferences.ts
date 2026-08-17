export const RESPONSE_TIMINGS = ["fast", "natural", "patient"] as const;

export type ResponseTiming = typeof RESPONSE_TIMINGS[number];

export interface SessionPreferences {
  responseTiming: ResponseTiming;
  speechRate: number;
}

export const DEFAULT_SESSION_PREFERENCES: SessionPreferences = {
  responseTiming: "natural",
  speechRate: 1,
};

const MIN_SPEECH_RATE = 0.75;
const MAX_SPEECH_RATE = 1.25;

export function parseSessionPreferences(value: unknown): SessionPreferences {
  if (value === undefined) return DEFAULT_SESSION_PREFERENCES;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session preferences must be an object");
  const candidate = value as Record<string, unknown>;
  const responseTiming = candidate.responseTiming ?? DEFAULT_SESSION_PREFERENCES.responseTiming;
  const speechRate = candidate.speechRate ?? DEFAULT_SESSION_PREFERENCES.speechRate;

  if (!RESPONSE_TIMINGS.includes(responseTiming as ResponseTiming)) throw new Error("Unsupported response timing");
  if (typeof speechRate !== "number" || !Number.isFinite(speechRate) || speechRate < MIN_SPEECH_RATE || speechRate > MAX_SPEECH_RATE) {
    throw new Error(`Speech rate must be between ${MIN_SPEECH_RATE} and ${MAX_SPEECH_RATE}`);
  }

  return { responseTiming: responseTiming as ResponseTiming, speechRate };
}
