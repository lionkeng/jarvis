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
  for (const packageName of ["@jarvis-viz/core", "@jarvis-viz/react", "@jarvis-viz/wc"]) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", scratch]);
  }
  const tarballs = readdirSync(scratch).filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== 3) throw new Error(`Expected three package tarballs, found ${tarballs.length}`);

  mkdirSync(consumer);
  const tarballFor = (fragment) => tarballs.find((file) => file.includes(fragment)) ?? "missing.tgz";
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "jarvis-viz-package-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@jarvis-viz/core": `file:../${tarballFor("core")}`,
      "@jarvis-viz/react": `file:../${tarballFor("react")}`,
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
    const motion: TextMotion = "flow";
    const theme: Partial<Theme> = { textMotion: motion, density: 1.2 };
    const mountCore = (host: HTMLElement) => {
      const viz = new VoiceViz({ theme });
      viz.mount(host);
      return viz;
    };
    void [VoiceViz, VoiceVizCanvas, TranscriptView, VoiceVizElement, defineVoiceVizElement, mountCore];
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
    if (typeof core.VoiceViz !== "function" || typeof reactAdapter.VoiceVizCanvas !== "function" || typeof webComponent.defineVoiceVizElement !== "function") throw new Error("Missing public package export");
    let rejected = false;
    try { await import("@jarvis-viz/core/src/render/theme.js"); } catch { rejected = true; }
    if (!rejected) throw new Error("Core deep import unexpectedly resolved");
  `;
  run("node", ["--input-type=module", "--eval", runtimeCheck], consumer);
  console.log("Packed package runtime, declarations, peers, and exports map are valid.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
