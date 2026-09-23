import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeToolResult, RealtimeTransport } from "@jarvis-viz/core";
import { REQUEST_UI_CHANGES_TOOL } from "@jarvis-viz/surface";
import { DemoVoiceFeatureSource } from "../demo-transport.js";

export type VoiceDemoScriptId =
  | "navigate"
  | "navigate-scroll"
  | "navigate-scroll-bottom"
  | "select"
  | "open-details"
  | "close-details"
  | "focus"
  | "activate"
  | "question";

interface VoiceDemoScript {
  id: VoiceDemoScriptId;
  user: string;
  agent: string;
  argumentsJson?: string;
}

function requests(...sentences: string[]): string {
  return JSON.stringify({ requests: sentences });
}

const SCRIPTS: Record<VoiceDemoScriptId, VoiceDemoScript> = {
  navigate: {
    id: "navigate",
    user: "Open the library.",
    agent: "Opening the library.",
    argumentsJson: requests("go to the library page"),
  },
  "navigate-scroll": {
    id: "navigate-scroll",
    user: "Open article and scroll",
    agent: "Opening the article and scrolling down.",
    argumentsJson: requests("go to the article page", "scroll the article down"),
  },
  "navigate-scroll-bottom": {
    id: "navigate-scroll-bottom",
    user: "Open the article and scroll to the bottom",
    agent: "Opened the article and scrolled to the bottom.",
    argumentsJson: requests("go to the article page", "scroll the article to the bottom"),
  },
  select: {
    id: "select",
    user: "Open the library and select Atlas.",
    agent: "Selected Atlas.",
    argumentsJson: requests("go to the library page", "select the Atlas card"),
  },
  "open-details": {
    id: "open-details",
    user: "Open the library details.",
    agent: "Opened the details panel.",
    argumentsJson: requests("go to the library page", "open the library details panel"),
  },
  "close-details": {
    id: "close-details",
    user: "Close the library details.",
    agent: "Closed the details panel.",
    argumentsJson: requests("close the library details panel"),
  },
  focus: {
    id: "focus",
    user: "Focus the dashboard search field.",
    agent: "Search is focused.",
    argumentsJson: requests("go to the dashboard page", "put the cursor in the search box"),
  },
  activate: {
    id: "activate",
    user: "Bookmark the article.",
    agent: "Bookmarked the article.",
    argumentsJson: requests("go to the article page", "bookmark this article"),
  },
  question: {
    id: "question",
    user: "What does this demo visualize?",
    agent: "It visualizes the remote agent audio while this page runs spoken requests through its own runner.",
  },
};

export const VOICE_DEMO_SCRIPTS: ReadonlyArray<{ id: VoiceDemoScriptId; label: string }> = [
  { id: "navigate", label: "Open the library" },
  { id: "navigate-scroll", label: "Open article and scroll" },
  { id: "navigate-scroll-bottom", label: "Scroll article to the bottom" },
  { id: "select", label: "Select Atlas" },
  { id: "open-details", label: "Open library details" },
  { id: "close-details", label: "Close library details" },
  { id: "focus", label: "Focus search" },
  { id: "activate", label: "Bookmark the article" },
  { id: "question", label: "Ask an ordinary question" },
];

export class VoiceDemoTransport implements RealtimeTransport {
  #listeners = new Set<RealtimeEventListener>();
  #timers = new Set<number>();
  #connected = false;
  #run = 0;
  #pendingCallId: string | undefined;
  readonly #toolResults: RealtimeToolResult[] = [];

  constructor(readonly signal = new DemoVoiceFeatureSource()) {}

  get connected(): boolean { return this.#connected; }
  get agentAudio(): MediaStreamTrack | null { return null; }
  get submittedToolResults(): readonly RealtimeToolResult[] { return this.#toolResults; }
  get pendingCallId(): string | undefined { return this.#pendingCallId; }

  subscribe(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.disconnect();
    this.#connected = true;
    this.signal.setAgentSpeaking(false);
    this.#emit({ type: "connected" });
  }

  disconnect(): void {
    this.#run += 1;
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers.clear();
    this.#pendingCallId = undefined;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.signal.setAgentSpeaking(false);
    if (wasConnected) this.#emit({ type: "disconnected" });
  }

  submitToolResult(result: RealtimeToolResult): void {
    this.#toolResults.push(result);
    if (!this.#connected || this.#pendingCallId !== result.callId) return;
    this.#pendingCallId = undefined;
    const spoken = spokenFollowUp(result);
    if (spoken === undefined) return;
    this.#stream(spoken);
  }

  playScript(id: VoiceDemoScriptId): void {
    if (!this.#connected) return;
    const script = SCRIPTS[id];
    this.signal.setAgentSpeaking(false);
    this.#emit({ type: "user-speech-started" });
    this.#later(120, () => {
      this.#emit({ type: "user-speech-stopped" });
      this.#emit({ type: "user-text", text: script.user });
      if (script.argumentsJson === undefined) {
        this.#later(80, () => this.#stream(script.agent));
        return;
      }
      const callId = `call_${script.id}_${crypto.randomUUID()}`;
      this.#pendingCallId = callId;
      this.#emit({
        type: "tool-call",
        call: { callId, name: REQUEST_UI_CHANGES_TOOL, argumentsJson: script.argumentsJson },
      });
    });
  }

  #stream(text: string): void {
    this.signal.setAgentSpeaking(true);
    this.#emit({ type: "agent-audio-started" });
    const chunks = text.match(/\S+\s*/g) ?? [text];
    chunks.forEach((chunk, index) => this.#later(index * 40, () => this.#emit({ type: "agent-text-delta", delta: chunk, audioSynchronized: true })));
    this.#later(chunks.length * 40 + 40, () => {
      this.signal.setAgentSpeaking(false);
      this.#emit({ type: "agent-text-done", text, audioSynchronized: true });
      this.#emit({ type: "response-done" });
    });
  }

  #later(delay: number, callback: () => void): void {
    const run = this.#run;
    const timer = window.setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#connected && this.#run === run) callback();
    }, delay);
    this.#timers.add(timer);
  }

  #emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function spokenFollowUp(result: RealtimeToolResult): string | undefined {
  const output = parseOutput(result.output);
  if (!output) return undefined;
  const results = Array.isArray(output.results) ? output.results : [];
  const cancelled = results.some((entry) => isPlainObject(entry) && entry.status === "cancelled");
  if (cancelled) return undefined;
  return typeof output.message === "string" ? output.message : undefined;
}

function parseOutput(output: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
