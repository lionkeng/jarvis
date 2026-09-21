import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|js|mjs)$/.test(path) ? [path] : [];
  });
}

function fail(file, message) {
  failures.push(`${relative(root, file)}: ${message}`);
}

const rootSource = join(root, "src");
if (existsSync(rootSource)) fail(rootSource, "root src/ must not exist after the workspace split");
for (const lock of [join(root, "bun.lock"), join(root, "bun.lockb"), join(root, "server/bun.lock"), join(root, "server/bun.lockb")]) {
  if (existsSync(lock)) fail(lock, "pnpm-lock.yaml is the only installation lockfile");
}

const coreSource = join(root, "packages/core/src");
const coreClassNames = new Set();
for (const file of sourceFiles(coreSource)) {
  const text = readFileSync(file, "utf8");
  const corePath = relative(coreSource, file).split(sep).join("/");
  // transport/types.ts is the normalized contract, so it gets no raw-name exemption.
  const rawNamesAllowed = corePath.startsWith("transport/") && corePath !== "transport/types.ts";
  if (!corePath.endsWith(".test.ts")) {
    for (const [, name] of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) coreClassNames.add(name);
  }
  if (corePath.startsWith("render/") && /from ["'][^"']*(?:transport\/(?!types(?:\.js)?["'])|audio\/media-stream-analyser)/.test(text)) {
    fail(file, "renderer code may consume leaf contracts, not transport or analyser implementations");
  }
  if (!rawNamesAllowed && /(?:session\.(?:input_transcript|output_transcript|close|started|usage|delegation)|input_audio_buffer\.|response\.(?:event|output_item|item|completed|failed|incomplete|cancelled|audio|output_audio|audio_transcript|output_audio_transcript|text|output_text|function_call_arguments|create\b)|conversation\.item\.(?:input_audio_transcription|create)|function_call_output)/.test(text)) {
    fail(file, "raw OpenAI event names belong only in transport/ channel implementations");
  }
  if (!rawNamesAllowed && /\b(?:BidiGenerateContent|realtimeInput|serverContent|setupComplete|modelTurn|inlineData|turnComplete|generationComplete|inputTranscription|outputTranscription|toolCallCancellation|functionCalls|functionResponses|toolResponse|sessionResumption|sessionResumptionUpdate|goAway|activityStart|activityEnd|audioStreamEnd)\b/.test(text)) {
    fail(file, "raw Gemini Live event names belong only in transport/ channel implementations");
  }
}

for (const packageSource of [join(root, "packages/react/src"), join(root, "packages/wc/src"), join(root, "apps/demo/src")]) {
  for (const file of sourceFiles(packageSource)) {
    const text = readFileSync(file, "utf8");
    if (/from ["']@jarvis-viz\/core\//.test(text) || /packages\/core\/src/.test(text)) fail(file, "consumers must import the core public entry point");
    if (/from ["'][^"']*server\//.test(text)) fail(file, "browser packages must not import the Bun server");
    if (!packageSource.includes(`${join("apps", "demo")}`) && /from ["'](?:xstate|@xstate\/react)["']/.test(text)) {
      fail(file, "XState must not appear outside the demo");
    }
  }
}

const demoTsconfig = join(root, "apps/demo/tsconfig.json");
if (existsSync(demoTsconfig) && /packages\/(?:core|react)\/src/.test(readFileSync(demoTsconfig, "utf8"))) {
  fail(demoTsconfig, "the demo must consume built package entry points, not TypeScript source aliases");
}

function packageManifests(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") return [];
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? packageManifests(path) : entry === "package.json" ? [path] : [];
  });
}

for (const file of packageManifests(root)) {
  const rel = relative(root, file);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const named = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  for (const dep of ["xstate", "@xstate/react"]) {
    if (named[dep] && rel !== "apps/demo/package.json") {
      fail(file, `${dep} is allowed only in apps/demo/package.json`);
    }
  }
}

const coreIndex = join(coreSource, "index.ts");
const forbiddenCoreExports = ["LiveTransport", "OpenAILiveChannel", "GeminiLiveChannel", "BrokerLease", "PcmDuplex", "CanvasRenderer"];
const indexText = existsSync(coreIndex) ? readFileSync(coreIndex, "utf8") : "";
for (const forbidden of forbiddenCoreExports) {
  if (!coreClassNames.has(forbidden)) {
    fail(import.meta.filename, `${forbidden} is on the forbidden core export list but packages/core/src declares no such class; update the list to the classes that exist`);
  }
  if (new RegExp(`\\b${forbidden}\\b`).test(indexText)) fail(coreIndex, `${forbidden} is an internal implementation, not a public export`);
}

const serverSource = join(root, "server/src");
for (const file of sourceFiles(serverSource)) {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith("/config.ts") && /\bBun\.env\b/.test(text)) fail(file, "only server/src/config.ts may read Bun.env");
  if (!file.endsWith("/index.ts") && !file.endsWith(".test.ts") && /\bBun\.serve\b/.test(text)) fail(file, "only server/src/index.ts may start an HTTP listener");
  if (/(?:globalThis\.)?(?:window|document)\.|\b(?:HTMLElement|HTMLCanvasElement|AudioContext|RTCPeerConnection)\b/.test(text)) {
    fail(file, "server package must not depend on browser globals");
  }
  if (/from ["'](?:node:)?(?:http|https|net|express|fastify)["']/.test(text)) fail(file, "the BFF uses Bun.serve and Fetch API, not Node HTTP frameworks");
  if (/from ["']@jarvis-viz\//.test(text) || /packages\/(?:core|react|wc)/.test(text)) fail(file, "the BFF must not import browser packages");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Package boundaries are valid.");
