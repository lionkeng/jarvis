import { describe, expect, test } from "bun:test";
import { SlidingWindowLimiter } from "./rate-limit.js";

describe("SlidingWindowLimiter", () => {
  test("limits each key independently and releases old entries", () => {
    const limiter = new SlidingWindowLimiter(2, 100);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1)).toBe(true);
    expect(limiter.take("a", 2)).toBe(false);
    expect(limiter.take("b", 2)).toBe(true);
    expect(limiter.take("a", 101)).toBe(true);
  });
});
