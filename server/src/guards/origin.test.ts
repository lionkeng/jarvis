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
  test("admits every spelling of a configured origin under one normalized origin and bucket", () => {
    for (const spelling of ["https://voice.example.com", "HTTPS://VOICE.example.com", "https://voice.example.com:443", "https://voice.example.com/x", "https://user@voice.example.com"]) {
      expect(guard.admit(spelling)).toEqual({ origin: "https://voice.example.com", bucket: "https://voice.example.com" });
    }
  });
  test("admits loopback origins under their own normalized origin and one shared bucket", () => {
    expect(guard.admit("http://localhost:5180")).toEqual({ origin: "http://localhost:5180", bucket: "loopback" });
    expect(guard.admit("http://127.0.0.1:4321/x")).toEqual({ origin: "http://127.0.0.1:4321", bucket: "loopback" });
    expect(guard.admit("https://[::1]:9")).toEqual({ origin: "https://[::1]:9", bucket: "loopback" });
  });
  test("admits nothing for a rejected origin", () => {
    expect(guard.admit("https://attacker.test")).toBeUndefined();
    expect(guard.admit(null)).toBeUndefined();
    expect(guard.admit("not a url")).toBeUndefined();
    expect(guard.admit("null")).toBeUndefined();
  });
  test("admits nothing for a non-http protocol wrapping an allowed origin", () => {
    expect(guard.admit("blob:http://localhost:5180/x")).toBeUndefined();
    expect(guard.admit("blob:https://voice.example.com/x")).toBeUndefined();
  });
  test("rejects suffix tricks, missing origins, and invalid URLs", () => {
    expect(guard.allows("https://voice.example.com.attacker.test")).toBe(false);
    expect(guard.allows("http://localhost.attacker.test")).toBe(false);
    expect(guard.allows(null)).toBe(false);
    expect(guard.allows("not a url")).toBe(false);
  });
});
