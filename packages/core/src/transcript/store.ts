import type { TranscriptFragment, TranscriptListener, TranscriptMessage, TranscriptRole, TranscriptSnapshot, TranscriptStatus } from "./types.js";

export class TranscriptStore {
  #messages: TranscriptMessage[] = [];
  #revision = 0;
  #snapshot: TranscriptSnapshot = { messages: this.#messages, revision: 0 };
  #listeners = new Set<TranscriptListener>();
  #nextId = 1;
  #timedSessionStartIndex = 0;

  getSnapshot = (): TranscriptSnapshot => this.#snapshot;

  subscribe = (listener: TranscriptListener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  appendDelta(role: TranscriptRole, delta: string, now = performance.now()): TranscriptMessage {
    const last = this.#messages.at(-1);
    if (last?.role === role && last.status === "streaming") {
      const updated = { ...last, text: last.text + delta, updatedAt: now };
      this.#messages = [...this.#messages.slice(0, -1), updated];
      this.#publish();
      return updated;
    }
    const message: TranscriptMessage = {
      id: `message-${this.#nextId++}`,
      role,
      text: delta,
      startedAt: now,
      updatedAt: now,
      status: "streaming",
    };
    this.#messages = [...this.#messages, message];
    this.#publish();
    return message;
  }

  beginTimedSession(): void {
    this.complete("user");
    this.complete("agent");
    this.#timedSessionStartIndex = this.#messages.length;
  }

  appendTimedDelta(role: TranscriptRole, fragment: TranscriptFragment, now = performance.now()): TranscriptMessage {
    let index = -1;
    for (let i = this.#messages.length - 1; i >= this.#timedSessionStartIndex; i -= 1) {
      const message = this.#messages[i];
      if (message?.role === role && message.fragments?.some((part) => fragment.startMs <= part.endMs + 1_000 && fragment.endMs >= part.startMs - 1_000)) { index = i; break; }
    }
    const current = this.#messages[index];
    const fragments = [...(current?.fragments ?? []), fragment].sort((a, b) => a.startMs - b.startMs);
    const message: TranscriptMessage = {
      id: current?.id ?? `message-${this.#nextId++}`,
      role, text: fragments.map((part) => part.delta).join(""), fragments,
      startedAt: current?.startedAt ?? now, updatedAt: now, status: current?.status ?? "streaming",
    };
    const messages = [...this.#messages];
    if (index >= 0) messages[index] = message;
    else {
      for (let i = 0; i < messages.length; i += 1) {
        const previous = messages[i];
        if (previous?.role === role && previous.status === "streaming") messages[i] = { ...previous, status: "complete" };
      }
      messages.push(message);
    }
    this.#messages = messages;
    this.#publish();
    return message;
  }

  appendMessage(role: TranscriptRole, text: string, now = performance.now()): TranscriptMessage {
    const current = this.#messages.at(-1);
    if (current?.role === role && current.status === "streaming") this.complete(role, "complete", now);
    const message: TranscriptMessage = {
      id: `message-${this.#nextId++}`,
      role,
      text,
      startedAt: now,
      updatedAt: now,
      status: "complete",
    };
    this.#messages = [...this.#messages, message];
    this.#publish();
    return message;
  }

  complete(role?: TranscriptRole, status: Extract<TranscriptStatus, "complete" | "interrupted"> = "complete", now = performance.now()): void {
    let index = -1;
    for (let candidate = this.#messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = this.#messages[candidate];
      if (message?.status === "streaming" && (role === undefined || message.role === role)) {
        index = candidate;
        break;
      }
    }
    if (index < 0) return;
    const current = this.#messages[index];
    if (!current) return;
    const next = [...this.#messages];
    next[index] = { ...current, status, updatedAt: now };
    this.#messages = next;
    this.#publish();
  }

  clear(): void {
    if (this.#messages.length === 0) return;
    this.#messages = [];
    this.#timedSessionStartIndex = 0;
    this.#publish();
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = { messages: this.#messages, revision: this.#revision };
    const snapshot = this.#snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
