import { SlidingWindowLimiter } from "./rate-limit.js";

export class SessionBudget {
  readonly #limiter: SlidingWindowLimiter;
  constructor(maxSessions: number, windowMs: number) { this.#limiter = new SlidingWindowLimiter(maxSessions, windowMs); }
  reserve(origin: string, now = Date.now()): boolean { return this.#limiter.take(origin, now); }
}
