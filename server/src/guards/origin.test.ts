import { describe, expect, test } from "bun:test";
import { OriginGuard } from "./origin.js";

describe("OriginGuard", () => {
  const guard = new OriginGuard(["https://voice.example.com", "http://localhost:5180"]);
  test("allows exact configured origins", () => expect(guard.allows("https://voice.example.com")).toBe(true));
  test("allows other loopback origins when a loopback origin is configured", () => {
    expect(guard.allows("http://localhost:5181")).toBe(true);
    expect(guard.allows("http://127.0.0.1:5180")).toBe(true);
    expect(guard.allows("http://[::1]:5180")).toBe(true);
  });
  test("does not broaden loopback when only remote origins are configured", () => {
    const remote = new OriginGuard(["https://voice.example.com"]);
    expect(remote.allows("http://localhost:5180")).toBe(false);
    expect(remote.allows("http://[::1]:5180")).toBe(false);
  });
  test("rejects suffix tricks, missing origins, and invalid URLs", () => {
    expect(guard.allows("https://voice.example.com.attacker.test")).toBe(false);
    expect(guard.allows("http://localhost.attacker.test")).toBe(false);
    expect(guard.allows(null)).toBe(false);
    expect(guard.allows("not a url")).toBe(false);
  });
});
