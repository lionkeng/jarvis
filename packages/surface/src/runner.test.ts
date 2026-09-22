import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRegistry } from "./registry.js";
import { createVoiceRunner, type Interpret, type VoiceRunner } from "./runner.js";
import type {
  InterpretAnswerMap,
  InterpretAnswers,
  InterpretRequest,
  ToolCall,
  ToolReport,
  ToolResult,
  VoiceCapability,
  VoiceCommand,
  VoiceControl,
  VoiceOutcome,
} from "./index.js";

type Label = {
  control: string;
  item?: string;
  to?: "on" | "off";
  axis?: string;
  direction?: "more" | "less";
  amount?: 1 | 2 | 3 | 4;
  confidence?: number;
};

function buildAnswers(compiled: InterpretRequest, label: Label | undefined): InterpretAnswers {
  const answers: InterpretAnswerMap = {};
  for (const [id, question] of Object.entries(compiled.questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: label === undefined ? 0.05 : 0.95 };
      continue;
    }
    if (question.type === "score") {
      answers[id] = {
        type: "score",
        score: (label?.amount ?? 1) - 1,
        legend: Object.fromEntries(question.criteria.map((level, index) => [`${index}`, level])),
        probabilities: Object.fromEntries(question.criteria.map((_level, index) => [`${index}`, 0.25])),
        confidence: 1,
      };
      continue;
    }
    const keys = Object.keys(question.criteria);
    let choice = id === "control" ? "none" : "not_stated";
    let confidence = 1;
    if (label !== undefined) {
      if (id === "control") {
        choice = label.control;
        confidence = label.confidence ?? 1;
      } else if (id === `${label.control}/item` && label.item !== undefined) choice = label.item;
      else if (id === `${label.control}/polarity` && label.to !== undefined) choice = label.to;
      else if (id === `${label.control}/axis` && label.axis !== undefined && label.direction !== undefined) {
        choice = `${label.axis}.${label.direction}`;
      }
    }
    answers[id] = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
      confidence,
    };
  }
  return { answers };
}

function toolCall(callId: string, ...requests: string[]): ToolCall {
  return { callId, name: "request_ui_changes", argumentsJson: JSON.stringify({ requests }) };
}

function outputs(submitted: ToolResult[]): ToolReport[] {
  return submitted.map((result) => JSON.parse(result.output) as ToolReport);
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The runner never reached the expected state");
}

type Harness = {
  runner: VoiceRunner;
  registry: VoiceRegistry;
  submitted: ToolResult[];
  log: string[];
  compiled: InterpretRequest[];
  page: () => string;
};

function harness(options: {
  labels: Record<string, Label | undefined>;
  interpret?: Interpret;
  queueLimit?: number;
}): Harness {
  const registry = new VoiceRegistry();
  const submitted: ToolResult[] = [];
  const log: string[] = [];
  const compiled: InterpretRequest[] = [];
  let page = "dashboard";
  let articleUndo: (() => void) | undefined;

  const articleContent: VoiceControl = {
    kind: "adjust",
    id: "article.content",
    what: "Scroll the article text",
    axes: [{ id: "vertical", more: "down", less: "up" }],
  };
  const articleCapability: VoiceCapability = {
    describe: () => ({ control: articleContent }),
    execute: async (command: VoiceCommand): Promise<VoiceOutcome> => {
      log.push(`scroll:${command.kind === "adjust" ? `${command.direction}:${command.amount}` : "?"}`);
      return { status: "done", say: "Scrolled down." };
    },
  };

  registry.register({
    describe: () => ({
      control: {
        kind: "pick",
        id: "navigation",
        what: "Go to a page of the app",
        items: [
          { id: "dashboard", spoken: "the dashboard page" },
          { id: "library", spoken: "the library page" },
          { id: "article", spoken: "the article page" },
        ],
      },
      facts: { page },
    }),
    execute: async (command: VoiceCommand): Promise<VoiceOutcome> => {
      const item = command.kind === "pick" ? command.item : "";
      log.push(`navigate:${item}`);
      page = item;
      // A host registers the controls of the new page one macrotask later, as React does.
      setTimeout(() => {
        articleUndo?.();
        articleUndo = undefined;
        if (page === "article") articleUndo = registry.register(articleCapability);
      }, 0);
      return { status: "done", say: `Opened the ${item}.` };
    },
  });

  registry.register({
    describe: () => ({ control: { kind: "press", id: "plan.reset", what: "Clear the plan", risk: "high" } }),
    execute: async (): Promise<VoiceOutcome> => {
      log.push("reset");
      return { status: "done", say: "Cleared the plan." };
    },
  });

  const interpret: Interpret =
    options.interpret ?? (async (request) => buildAnswers(request, options.labels[request.state.request]));

  const runner = createVoiceRunner({
    registry,
    interpret: async (request, signal) => {
      compiled.push(request);
      return interpret(request, signal);
    },
    submit: (result) => {
      submitted.push(result);
    },
    screen: () => ({ surface: "Jarvis voice demo", page }),
    ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit }),
  });

  return { runner, registry, submitted, log, compiled, page: () => page };
}

describe("createVoiceRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the requests of one call in order and submits one result", async () => {
    const world = harness({
      labels: {
        "go to the library page": { control: "navigation", item: "library" },
        "go to the article page": { control: "navigation", item: "article" },
      },
    });
    world.runner.handle(toolCall("call-1", "go to the library page", "go to the article page"));
    await until(() => world.submitted.length === 1);
    expect(world.log).toEqual(["navigate:library", "navigate:article"]);
    expect(outputs(world.submitted)[0]).toEqual({
      ok: true,
      message: "Opened the library. Opened the article.",
      results: [
        { request: "go to the library page", status: "done", say: "Opened the library." },
        { request: "go to the article page", status: "done", say: "Opened the article." },
      ],
    });
  });

  it("runs two calls in the order they arrived", async () => {
    const world = harness({
      labels: {
        "go to the library page": { control: "navigation", item: "library" },
        "go to the article page": { control: "navigation", item: "article" },
      },
    });
    world.runner.handle(toolCall("call-1", "go to the library page"));
    world.runner.handle(toolCall("call-2", "go to the article page"));
    await until(() => world.submitted.length === 2);
    expect(world.log).toEqual(["navigate:library", "navigate:article"]);
    expect(world.submitted.map((result) => result.callId)).toEqual(["call-1", "call-2"]);
  });

  it("drops a repeated call id", async () => {
    const world = harness({ labels: { "go to the library page": { control: "navigation", item: "library" } } });
    const call = toolCall("call-1", "go to the library page");
    world.runner.handle(call);
    world.runner.handle(call);
    await until(() => world.submitted.length === 1);
    world.runner.handle(call);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.submitted).toHaveLength(1);
    expect(world.log).toEqual(["navigate:library"]);
  });

  it("reports invalid arguments without asking for an interpretation", async () => {
    const world = harness({ labels: {} });
    world.runner.handle({ callId: "call-1", name: "request_ui_changes", argumentsJson: '{"actions":[]}' });
    await until(() => world.submitted.length === 1);
    expect(outputs(world.submitted)[0]).toEqual({
      ok: false,
      message: "That request was not understood.",
      results: [{ request: "", status: "invalid_arguments" }],
    });
    expect(world.compiled).toHaveLength(0);
  });

  it("refuses a call once the queue is full", async () => {
    let release: (() => void) | undefined;
    const world = harness({
      labels: { "go to the library page": { control: "navigation", item: "library" } },
      queueLimit: 1,
      interpret: async (request) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return buildAnswers(request, { control: "navigation", item: "library" });
      },
    });
    world.runner.handle(toolCall("call-1", "go to the library page"));
    world.runner.handle(toolCall("call-2", "go to the library page"));
    expect(outputs(world.submitted)[0]).toEqual({
      ok: false,
      message: "Too many requests at once.",
      results: [{ request: "", status: "queue_full" }],
    });
    expect(world.runner.getSnapshot()).toMatchObject({ reports: [], queued: 1 });
    await until(() => release !== undefined);
    release?.();
    await until(() => world.submitted.length === 2);
    expect(world.submitted.map((result) => result.callId)).toEqual(["call-2", "call-1"]);
  });

  it("reports cancelled when an interrupt lands during the interpretation", async () => {
    let started: (() => void) | undefined;
    const world = harness({
      labels: {},
      interpret: (_request, signal) =>
        new Promise((_resolve, reject) => {
          started?.();
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    world.runner.handle(toolCall("call-1", "go to the library page"));
    await startedPromise;
    world.runner.interrupt();
    await until(() => world.submitted.length === 1);
    expect(outputs(world.submitted)[0]).toMatchObject({
      ok: false,
      message: "Cancelled.",
      results: [{ request: "go to the library page", status: "cancelled" }],
    });
    expect(world.log).toEqual([]);
  });

  it("reports cancelled when an interrupt lands during the execution", async () => {
    const registry = new VoiceRegistry();
    const submitted: ToolResult[] = [];
    let executing: (() => void) | undefined;
    registry.register({
      describe: () => ({ control: { kind: "press", id: "dashboard.search", what: "Put the cursor in the search box" } }),
      execute: (_command, signal) =>
        new Promise<VoiceOutcome>((_resolve, reject) => {
          executing?.();
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    });
    const runner = createVoiceRunner({
      registry,
      interpret: async (request) => buildAnswers(request, { control: "dashboard.search" }),
      submit: (result) => {
        submitted.push(result);
      },
      screen: () => ({ surface: "Jarvis voice demo", page: "dashboard" }),
    });
    const executingPromise = new Promise<void>((resolve) => {
      executing = resolve;
    });
    runner.handle(toolCall("call-1", "put the cursor in the search box"));
    await executingPromise;
    runner.interrupt();
    await until(() => submitted.length === 1);
    expect(outputs(submitted)[0]).toMatchObject({ ok: false, message: "Cancelled." });
  });

  it("cancels the active call and clears the queue on a disconnect", async () => {
    let release: (() => void) | undefined;
    const world = harness({
      labels: { "go to the library page": { control: "navigation", item: "library" } },
      interpret: (request, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve(buildAnswers(request, { control: "navigation", item: "library" }));
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    });
    world.runner.handle(toolCall("call-1", "go to the library page"));
    world.runner.handle(toolCall("call-2", "go to the library page"));
    await until(() => release !== undefined);
    world.runner.reset();
    await until(() => world.submitted.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.submitted).toHaveLength(1);
    expect(outputs(world.submitted)[0]).toMatchObject({ results: [{ status: "cancelled" }] });
    expect(world.log).toEqual([]);
    expect(world.runner.getSnapshot().queued).toBe(0);
  });

  it("reports unclear instead of running a command below the bar", async () => {
    const world = harness({
      labels: { "go to that page": { control: "navigation", item: "library", confidence: 0.3 } },
    });
    world.runner.handle(toolCall("call-1", "go to that page"));
    await until(() => world.submitted.length === 1);
    expect(outputs(world.submitted)[0]).toMatchObject({
      ok: false,
      results: [{ status: "unclear", candidates: ["Go to a page of the app", "Clear the plan"] }],
    });
    expect(world.log).toEqual([]);
  });

  it("holds a high risk control to the high bar", async () => {
    const world = harness({ labels: { "start over": { control: "plan.reset", confidence: 0.8 } } });
    world.runner.handle(toolCall("call-1", "start over"));
    await until(() => world.submitted.length === 1);
    expect(outputs(world.submitted)[0]).toMatchObject({ ok: false, results: [{ status: "unclear" }] });
    expect(world.log).toEqual([]);

    const sure = harness({ labels: { "start over": { control: "plan.reset", confidence: 0.9 } } });
    sure.runner.handle(toolCall("call-2", "start over"));
    await until(() => sure.submitted.length === 1);
    expect(sure.log).toEqual(["reset"]);
  });

  it("compiles the second request only after the registry settles", async () => {
    const world = harness({
      labels: {
        "go to the article page": { control: "navigation", item: "article" },
        "scroll the article to the bottom": {
          control: "article.content",
          axis: "vertical",
          direction: "more",
          amount: 4,
        },
      },
    });
    world.runner.handle(toolCall("call-1", "go to the article page", "scroll the article to the bottom"));
    await until(() => world.submitted.length === 1);
    expect(world.log).toEqual(["navigate:article", "scroll:more:4"]);
    const second = world.compiled[1];
    expect(Object.keys(second?.questions ?? {})).toContain("article.content/axis");
    expect(second?.state.screen).toEqual({ surface: "Jarvis voice demo", page: "article" });
    expect(outputs(world.submitted)[0]).toMatchObject({ ok: true, message: "Opened the article. Scrolled down." });
  });

  it("stops at the first request that did not finish", async () => {
    const world = harness({
      labels: {
        "go to the library page": { control: "navigation", item: "library" },
        "what is the weather": undefined,
        "go to the article page": { control: "navigation", item: "article" },
      },
    });
    world.runner.handle(
      toolCall("call-1", "go to the library page", "what is the weather", "go to the article page"),
    );
    await until(() => world.submitted.length === 1);
    expect(world.log).toEqual(["navigate:library"]);
    expect(outputs(world.submitted)[0]).toMatchObject({
      ok: false,
      message: "That is not something on this screen.",
      results: [{ status: "done" }, { status: "none" }],
    });
  });

  it("logs a submit failure instead of breaking the chain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = new VoiceRegistry();
    const submitted: string[] = [];
    registry.register({
      describe: () => ({ control: { kind: "press", id: "dashboard.search", what: "Put the cursor in the search box" } }),
      execute: async (): Promise<VoiceOutcome> => ({ status: "done" }),
    });
    const runner = createVoiceRunner({
      registry,
      interpret: async (request) => buildAnswers(request, { control: "dashboard.search" }),
      submit: (result) => {
        if (result.callId === "call-1") throw new Error("the session is gone");
        submitted.push(result.callId);
      },
      screen: () => ({ surface: "Jarvis voice demo", page: "dashboard" }),
    });
    runner.handle(toolCall("call-1", "put the cursor in the search box"));
    runner.handle(toolCall("call-2", "put the cursor in the search box"));
    await until(() => submitted.length === 1);
    expect(submitted).toEqual(["call-2"]);
    expect(error).toHaveBeenCalledOnce();
  });

  it("keeps one snapshot object until something changes", async () => {
    const world = harness({ labels: { "go to the library page": { control: "navigation", item: "library" } } });
    const seen: string[] = [];
    const unsubscribe = world.runner.subscribe(() => {
      const snapshot = world.runner.getSnapshot();
      if (seen.at(-1) !== snapshot.phase) seen.push(snapshot.phase);
    });
    const first = world.runner.getSnapshot();
    expect(world.runner.getSnapshot()).toBe(first);
    world.runner.handle(toolCall("call-1", "go to the library page"));
    await until(() => world.submitted.length === 1);
    unsubscribe();
    expect(seen).toEqual(["idle", "interpreting", "executing", "reporting", "idle"]);
    const snapshot = world.runner.getSnapshot();
    expect(snapshot).toBe(world.runner.getSnapshot());
    expect(snapshot.lastMessage).toBe("Opened the library.");
    expect(snapshot.queued).toBe(0);
    expect(snapshot.timing.addedMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.timing.interpretMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.timing.executeMs).toBeGreaterThanOrEqual(0);
  });
});
