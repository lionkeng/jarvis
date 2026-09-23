import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const root = resolve(import.meta.dirname, "..");
const documentPath = resolve(root, "docs/architecture.html");
const html = readFileSync(documentPath, "utf8");
const dom = new JSDOM(html);
const { document } = dom.window;
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

const requiredSections = ["system", "layout", "modules", "conversation", "states", "interaction", "visualization", "text", "simulation", "gotchas"];
for (const id of requiredSections) expect(document.getElementById(id), `missing #${id}`);

expect(document.querySelectorAll("h1").length === 1, "the document must contain exactly one h1");

const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
expect(duplicateIds.length === 0, `duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);

for (const anchor of document.querySelectorAll('nav a[href^="#"]')) {
  const id = anchor.getAttribute("href").slice(1);
  expect(Boolean(document.getElementById(id)), `nav anchor points to missing #${id}`);
}

const allowedExternalHrefs = new Set([
  "https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends",
]);

for (const element of document.querySelectorAll("[src], link[href], a[href]")) {
  const value = element.getAttribute(element.hasAttribute("src") ? "src" : "href") ?? "";
  if (element.tagName === "A" && (value.startsWith("#") || allowedExternalHrefs.has(value))) continue;
  expect(!/^(?:https?:)?\/\//i.test(value), `external asset or link URL: ${value}`);
}

const facts = [
  "20,000 ms", "18 chars/s", "850 ms", "5,000 ms", "250 ms", "100 ms", "2048", "0.78", "640", "marin", "gpt-live-1",
  "idle", "listening", "thinking", "speaking", "interrupted", "error",
  "request_ui_changes", "interpret", "jev-1.13.0", "TYPESAFE_API_KEY",
  "bars", "waveform", "ring", "particles", "hud",
  "Network timing is variable", "Provider transcript and audio timing are variable",
  "OPENAI_LIVE_MODEL", "OPENAI_LIVE_BACKEND_MODEL", "LIFETIME_STREAMS_PER_ORIGIN", "session.started", "session.closed", "parallel_tool_calls",
  "providererror", "backendfailed",
];
for (const fact of facts) expect(html.includes(fact), `missing required fact: ${fact}`);

for (const phase of ["idle", "interpreting", "executing", "reporting"]) {
  expect(html.includes(`<span class="state">${phase}</span>`), `missing runner phase ${phase}`);
}

for (const element of document.querySelectorAll("[data-source]")) {
  const source = element.getAttribute("data-source");
  expect(Boolean(source), "empty data-source attribute");
  if (source) expect(existsSync(resolve(root, source)), `data-source does not exist: ${source}`);
}

expect(document.querySelectorAll('svg[role="img"]').length >= 2, "expected two accessible SVG diagrams");
expect(!html.includes("—"), "em dash character found");

if (failures.length) {
  console.error("Architecture documentation check failed.");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Architecture documentation check passed.");
}
