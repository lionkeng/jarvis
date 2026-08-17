import { describe, expect, test } from "bun:test";
import { OriginGuard } from "./origin.js";

describe("OriginGuard", () => {
  const guard = new OriginGuard(["https://voice.example.com", "http://localhost:5173"]);
  test("allows exact configured origins", () => expect(guard.allows("https://voice.example.com")).toBe(true));
  test("rejects suffix tricks, missing origins, and invalid URLs", () => {
    expect(guard.allows("https://voice.example.com.attacker.test")).toBe(false);
    expect(guard.allows(null)).toBe(false);
    expect(guard.allows("not a url")).toBe(false);
  });
});
