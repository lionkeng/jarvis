export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #events = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  take(key: string, now = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    const recent = (this.#events.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.#limit) {
      this.#events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#events.set(key, recent);
    return true;
  }
}
