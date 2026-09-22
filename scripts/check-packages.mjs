import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "jarvis-viz-pack-"));
const consumer = join(scratch, "consumer");
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  env: { ...process.env, CI: "true" },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  for (const packageName of ["@jarvis-viz/core", "@jarvis-viz/react", "@jarvis-viz/surface", "@jarvis-viz/wc"]) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", scratch]);
  }
  const tarballs = readdirSync(scratch).filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== 4) throw new Error(`Expected four package tarballs, found ${tarballs.length}`);

  mkdirSync(consumer);
  const tarballFor = (fragment) => tarballs.find((file) => file.includes(fragment)) ?? "missing.tgz";
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "jarvis-viz-package-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@jarvis-viz/core": `file:../${tarballFor("core")}`,
      "@jarvis-viz/react": `file:../${tarballFor("react")}`,
      "@jarvis-viz/surface": `file:../${tarballFor("surface")}`,
      "@jarvis-viz/wc": `file:../${tarballFor("wc")}`,
      react: "19.2.0",
      "react-dom": "19.2.0",
    },
    devDependencies: {
      "@types/react": "19.2.0",
      "@types/react-dom": "19.2.0",
      typescript: "7.0.2",
    },
  }, null, 2));
  writeFileSync(join(consumer, "index.ts"), `
    import { VoiceViz, type TextMotion, type Theme } from "@jarvis-viz/core";
    import { TranscriptView, VoiceVizCanvas } from "@jarvis-viz/react";
    import { VoiceVizElement, defineVoiceVizElement } from "@jarvis-viz/wc";
    import {
      DEFAULT_BARS,
      VoiceRegistry,
      compileInterpretRequest,
      createVoiceRunner,
      decodeInterpretAnswers,
      type VoiceControl,
    } from "@jarvis-viz/surface";
    import { useVoiceCapability } from "@jarvis-viz/surface/react";
    const motion: TextMotion = "flow";
    const theme: Partial<Theme> = { textMotion: motion, density: 1.2 };
    const mountCore = (host: HTMLElement) => {
      const viz = new VoiceViz({ theme });
      viz.mount(host);
      return viz;
    };
    const describeSurface = (registry: VoiceRegistry) => {
      const controls: VoiceControl[] = registry.describe().controls;
      const compiled = compileInterpretRequest({ request: "go to the library page", screen: { page: "dashboard" }, controls });
      const decoded = decodeInterpretAnswers({ answers: {}, controls, bars: DEFAULT_BARS });
      return { compiled, decoded };
    };
    void [VoiceViz, VoiceVizCanvas, TranscriptView, VoiceVizElement, defineVoiceVizElement, mountCore];
    void [VoiceRegistry, createVoiceRunner, useVoiceCapability, describeSurface];
  `);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      skipLibCheck: false,
    },
    include: ["index.ts"],
  }, null, 2));

  run("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], consumer);
  run(join(consumer, "node_modules/.bin/tsc"), [], consumer);
  const runtimeCheck = `
    globalThis.HTMLElement = class {};
    const core = await import("@jarvis-viz/core");
    const reactAdapter = await import("@jarvis-viz/react");
    const webComponent = await import("@jarvis-viz/wc");
    const surface = await import("@jarvis-viz/surface");
    const surfaceReact = await import("@jarvis-viz/surface/react");
    if (typeof core.VoiceViz !== "function" || typeof reactAdapter.VoiceVizCanvas !== "function" || typeof webComponent.defineVoiceVizElement !== "function") throw new Error("Missing public package export");
    if (typeof surface.createVoiceRunner !== "function" || typeof surface.VoiceRegistry !== "function" || typeof surfaceReact.useVoiceCapability !== "function") throw new Error("Missing public surface export");
    let rejected = false;
    try { await import("@jarvis-viz/core/src/render/theme.js"); } catch { rejected = true; }
    if (!rejected) throw new Error("Core deep import unexpectedly resolved");
  `;
  run("node", ["--input-type=module", "--eval", runtimeCheck], consumer);
  console.log("Packed package runtime, declarations, peers, and exports map are valid.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
