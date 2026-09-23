import { readFileSync } from "node:fs";
import {
  DEFAULT_BARS,
  compileInterpretRequest,
  decodeInterpretAnswers,
} from "../packages/surface/dist/index.js";
import type {
  InterpretAnswerMap,
  InterpretRequest,
  Interpretation,
  VoiceCommand,
  VoiceControl,
} from "../packages/surface/dist/index.js";
import { DEMO_CONTROLS, DEMO_FACTS, DEMO_SURFACE_NAME, type DemoPage } from "./fixtures/demo-surface.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const RETRIES = 2;
const KINDS = ["press", "pick", "toggle", "adjust", "none"] as const;

type Kind = (typeof KINDS)[number];
type Expectation = "none" | VoiceCommand;
type CorpusEntry = {
  request: string;
  page: DemoPage;
  facts?: Record<string, string>;
  on?: boolean;
  expect: Expectation;
};
type Answered = { answers: InterpretAnswerMap; inputTokens: number };
type Measurement = { kind: Kind; correct: boolean; executed: boolean; confidence: number; latencyMs: number; inputTokens: number };

const options = parseOptions(process.argv.slice(2));
const corpus = JSON.parse(readFileSync(options.corpus, "utf8")) as CorpusEntry[];
const key = process.env.TYPESAFE_API_KEY;
if (!options.dryRun && (key === undefined || key.length === 0)) {
  console.error("Set TYPESAFE_API_KEY for a live run, or pass --dry-run.");
  process.exit(1);
}

const measurements: Measurement[] = [];
for (const entry of corpus) {
  const controls = controlsFor(entry);
  const compiled = compileInterpretRequest({
    request: entry.request,
    screen: { surface: DEMO_SURFACE_NAME, page: entry.page, ...DEMO_FACTS[entry.page], ...entry.facts },
    controls,
  });
  const startedAt = performance.now();
  const answered = options.dryRun ? answersFromLabel(compiled, entry.expect) : await ask(compiled, options.model, key ?? "");
  const latencyMs = performance.now() - startedAt;
  const interpretation = decodeInterpretAnswers({ answers: answered.answers, controls, bars: DEFAULT_BARS });
  const correct = matches(interpretation, entry.expect);
  measurements.push({
    kind: entry.expect === "none" ? "none" : entry.expect.kind,
    correct,
    executed: interpretation.kind === "command",
    confidence: "confidence" in interpretation ? interpretation.confidence : 0,
    latencyMs,
    inputTokens: answered.inputTokens,
  });
  if (!correct) console.log(`miss  ${entry.page}  ${entry.request}  ->  ${describe(interpretation)}`);
}

report(measurements, options.dryRun);
if (options.dryRun && measurements.some((measurement) => !measurement.correct)) process.exitCode = 1;

function parseOptions(argv: string[]): { dryRun: boolean; model: string; corpus: string } {
  let dryRun = false;
  let model = DEFAULT_MODEL;
  let corpus = new URL("./fixtures/interpret-corpus.json", import.meta.url).pathname;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--model") model = argv[++index] ?? DEFAULT_MODEL;
    else if (flag === "--corpus") corpus = argv[++index] ?? corpus;
    else {
      console.error(`Unknown flag ${flag}. Usage: eval-interpret.ts [--dry-run] [--model <id>] [--corpus <path>]`);
      process.exit(1);
    }
  }
  return { dryRun, model, corpus };
}

function controlsFor(entry: CorpusEntry): VoiceControl[] {
  const controls = DEMO_CONTROLS[entry.page];
  if (entry.on !== true || entry.expect === "none") return controls;
  const target = entry.expect.control;
  return controls.map((control) =>
    control.id === target && control.kind === "toggle"
      ? { ...control, items: control.items.map((item) => ({ ...item, on: true })) }
      : control,
  );
}

function answersFromLabel(compiled: InterpretRequest, expectation: Expectation): Answered {
  const command = expectation === "none" ? undefined : expectation;
  const answers: InterpretAnswerMap = {};
  for (const [id, question] of Object.entries(compiled.questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: command === undefined ? 0.05 : 0.95 };
      continue;
    }
    if (question.type === "score") {
      const amount = command !== undefined && command.kind === "adjust" ? command.amount : 1;
      answers[id] = {
        type: "score",
        score: amount - 1,
        legend: Object.fromEntries(question.criteria.map((level, index) => [`${index}`, level])),
        probabilities: Object.fromEntries(
          question.criteria.map((_level, index) => [`${index}`, index === amount - 1 ? 1 : 0]),
        ),
        confidence: 1,
      };
      continue;
    }
    const choice = choiceFor(id, command);
    answers[id] = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])),
      confidence: 1,
    };
  }
  return { answers, inputTokens: estimateInputTokens(compiled) };
}

function choiceFor(id: string, command: VoiceCommand | undefined): string {
  if (command === undefined) return id === "control" ? "none" : "not_stated";
  if (id === "control") return command.control;
  if (id === `${command.control}/item` && (command.kind === "pick" || command.kind === "toggle")) return command.item;
  if (id === `${command.control}/polarity` && command.kind === "toggle") return command.to;
  if (id === `${command.control}/axis` && command.kind === "adjust") return `${command.axis}.${command.direction}`;
  return "not_stated";
}

function estimateInputTokens(compiled: InterpretRequest): number {
  return Math.ceil(JSON.stringify(compiled).length / 4);
}

async function ask(compiled: InterpretRequest, model: string, bearer: string): Promise<Answered> {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ model, state: compiled.state, questions: compiled.questions }),
    });
    if ((response.status === 429 || response.status === 529) && attempt < RETRIES) {
      await wait(backoffMs(attempt, response.headers.get("retry-after")));
      continue;
    }
    if (!response.ok) throw new Error(`TypeSafe answered ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { answers: InterpretAnswerMap; usage?: Record<string, number> };
    return { answers: body.answers, inputTokens: inputTokensOf(body.usage) };
  }
  throw new Error("TypeSafe kept rate limiting the request");
}

function inputTokensOf(usage: Record<string, number> | undefined): number {
  if (usage === undefined) return 0;
  return usage["input_tokens"] ?? usage["inputTokens"] ?? usage["prompt_tokens"] ?? 0;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1_000 : 500 * 2 ** attempt;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matches(interpretation: Interpretation, expectation: Expectation): boolean {
  if (expectation === "none") return interpretation.kind === "none";
  if (interpretation.kind !== "command") return false;
  return JSON.stringify(interpretation.command) === JSON.stringify(expectation);
}

function describe(interpretation: Interpretation): string {
  switch (interpretation.kind) {
    case "command":
      return `${interpretation.kind} ${JSON.stringify(interpretation.command)}`;
    case "unclear":
      return `unclear ${interpretation.candidates.join(" or ")}`;
    case "none":
      return `none operates ${interpretation.operates.toFixed(2)}`;
    case "malformed":
      return `malformed ${interpretation.reason}`;
  }
}

function report(results: Measurement[], dryRun: boolean): void {
  const rows = [["kind", "entries", "correct", "accuracy"]];
  for (const kind of KINDS) {
    const of = results.filter((result) => result.kind === kind);
    rows.push([kind, `${of.length}`, `${of.filter((result) => result.correct).length}`, percent(of)]);
  }
  rows.push(["total", `${results.length}`, `${results.filter((result) => result.correct).length}`, percent(results)]);
  console.log("\nAccuracy by command kind");
  printTable(rows);

  const executed = results.filter((result) => result.executed);
  const bins = [["confidence", "correct", "incorrect"]];
  for (let bin = 0; bin < 10; bin += 1) {
    const of = executed.filter((result) => Math.min(9, Math.floor(result.confidence * 10)) === bin);
    bins.push([
      `${(bin / 10).toFixed(1)} to ${((bin + 1) / 10).toFixed(1)}`,
      `${of.filter((result) => result.correct).length}`,
      `${of.filter((result) => !result.correct).length}`,
    ]);
  }
  console.log(`\nConfidence against correctness, over the ${executed.length} commands that would run`);
  printTable(bins);

  const latencies = results.map((result) => result.latencyMs).sort((left, right) => left - right);
  console.log("\nRequest latency");
  printTable([
    ["measure", "value"],
    ["p50", `${Math.round(quantile(latencies, 0.5))} ms`],
    ["p95", `${Math.round(quantile(latencies, 0.95))} ms`],
  ]);

  const tokens = results.reduce((total, result) => total + result.inputTokens, 0);
  console.log(`\nInput tokens per request${dryRun ? ", estimated from the compiled request" : ""}`);
  printTable([
    ["measure", "value"],
    ["mean", `${results.length === 0 ? 0 : Math.round(tokens / results.length)}`],
  ]);
  console.log("");
}

function percent(results: Measurement[]): string {
  if (results.length === 0) return "n/a";
  return `${((results.filter((result) => result.correct).length / results.length) * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function printTable(rows: string[][]): void {
  const widths = (rows[0] ?? []).map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
  }
}
