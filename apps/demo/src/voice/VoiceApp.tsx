import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createLiveTransport, VoiceViz, type LiveProtocolId, type RealtimeTransport, type ResponseTiming, type TranscriptStore, type VoiceFeatureSource } from "@jarvis-viz/core";
import { TranscriptView } from "@jarvis-viz/react";
import { VoiceRegistry, createVoiceRunner } from "@jarvis-viz/surface";
import { createHashRouter } from "./hash-router.js";
import { NavigationCapability, RoutePage, type LibraryItem, type ThemeChoice } from "./pages.js";
import { SIMULATION_TABLE, createLiveInterpret, createSimulatedInterpret } from "./runner-source.js";
import { VOICE_DEMO_SCRIPTS, VoiceDemoTransport } from "./voice-demo-transport.js";
import { DemoVoiceFeatureSource } from "../demo-transport.js";

type ConnectionPhase = "disconnected" | "connecting" | "connected" | "closing";
type SourceMode = "simulation" | LiveProtocolId;
const SURFACE_NAME = "Jarvis voice demo";
const RESPONSE_TIMINGS: ReadonlyArray<{ value: ResponseTiming; label: string }> = [
  { value: "fast", label: "Fast" },
  { value: "natural", label: "Natural" },
  { value: "patient", label: "Patient" },
];
const LIVE_SOURCES: ReadonlyArray<{ mode: LiveProtocolId; label: string }> = [
  { mode: "openai-live", label: "OpenAI" },
  { mode: "gemini-live", label: "Gemini" },
];
const ROUTES = ["dashboard", "library", "article", "settings"] as const;

function createSource(mode: SourceMode): { transport: RealtimeTransport; featureSource?: VoiceFeatureSource; demo?: VoiceDemoTransport } {
  if (mode !== "simulation") return { transport: createLiveTransport({ protocol: mode }) };
  const featureSource = new DemoVoiceFeatureSource();
  const demo = new VoiceDemoTransport(featureSource);
  return { transport: demo, featureSource, demo };
}

export function VoiceApp() {
  const registry = useRef(new VoiceRegistry()).current;
  const router = useRef(createHashRouter()).current;
  const vizRef = useRef<VoiceViz | undefined>(undefined);
  const demoTransportRef = useRef<VoiceDemoTransport | undefined>(undefined);
  const connectionAttempt = useRef(0);
  const mountRef = useRef<HTMLDivElement | null>(null);

  const route = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);

  const [mode, setMode] = useState<SourceMode>("simulation");
  const [endpoint, setEndpoint] = useState("http://localhost:3010/session");
  const [responseTiming, setResponseTiming] = useState<ResponseTiming>("natural");
  const [speechRate, setSpeechRate] = useState(1);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>("disconnected");
  const [status, setStatus] = useState("Ready");
  const [transcriptStore, setTranscriptStore] = useState<TranscriptStore | undefined>(undefined);
  const [libraryItem, setLibraryItem] = useState<LibraryItem | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>("dark");
  const [bookmarked, setBookmarked] = useState(false);
  const [liveMessage, setLiveMessage] = useState("Voice app ready");

  const runner = useMemo(() => createVoiceRunner({
    registry,
    interpret: mode === "simulation" ? createSimulatedInterpret(SIMULATION_TABLE) : createLiveInterpret(endpoint),
    submit: (result) => { vizRef.current?.submitToolResult(result); },
    screen: () => ({ surface: SURFACE_NAME, page: router.getSnapshot() }),
  }), [registry, router, mode, endpoint]);
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const runnerRef = useRef(runner);
  const voiceBusy = snapshot.phase !== "idle" || snapshot.queued > 0;
  const settingsLocked = connectionPhase !== "disconnected" || voiceBusy;

  useEffect(() => {
    runnerRef.current = runner;
    return () => { runner.reset(); };
  }, [runner]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => () => router.dispose(), [router]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const source = createSource(mode);
    demoTransportRef.current = source.demo;
    const viz = new VoiceViz({
      transport: source.transport,
      ...(source.featureSource ? { featureSource: source.featureSource } : {}),
      presets: ["ring", "hud"],
      reducedMotion,
    });
    viz.mount(host);
    vizRef.current = viz;
    setTranscriptStore(viz.transcript);
    const unsubTool = viz.on("toolcall", (call) => {
      runnerRef.current.handle(call);
    });
    const unsubState = viz.on("statechange", ({ state }) => {
      setStatus(state);
      const phase = runnerRef.current.getSnapshot().phase;
      if (mode === "simulation" && state === "listening" && (phase === "interpreting" || phase === "executing")) {
        runnerRef.current.interrupt();
      }
    });
    const unsubDisconnect = viz.on("disconnected", () => {
      setConnectionPhase("disconnected");
      if (viz.state !== "error") setStatus("Disconnected");
      runnerRef.current.reset();
    });
    const unsubError = viz.on("error", ({ error }) => {
      connectionAttempt.current += 1;
      setConnectionPhase("disconnected");
      setStatus(error.message);
      setLiveMessage(error.message);
      runnerRef.current.reset();
    });
    const unsubBackendFailed = viz.on("backendfailed", ({ status }) => { setStatus(`Backend response ${status}`); });
    const unsubProviderError = viz.on("providererror", ({ message }) => { setStatus(message); });
    if (source.demo) void viz.connect("demo");
    return () => {
      unsubTool();
      unsubState();
      unsubError();
      unsubDisconnect();
      unsubBackendFailed();
      unsubProviderError();
      viz.unmount();
      vizRef.current = undefined;
      demoTransportRef.current = undefined;
      setTranscriptStore(undefined);
    };
  }, [mode]);

  const selectMode = (nextMode: SourceMode) => {
    if (nextMode === mode || voiceBusy) return;
    connectionAttempt.current += 1;
    setConnectionPhase("disconnected");
    setStatus(nextMode === "simulation" ? "idle" : "Ready");
    setMode(nextMode);
  };

  const toggleLiveConnection = async () => {
    const viz = vizRef.current;
    if (!viz || (connectionPhase === "connecting" || connectionPhase === "closing") || voiceBusy) return;
    if (connectionPhase === "connected" || viz.connected) {
      connectionAttempt.current += 1;
      setConnectionPhase("closing");
      setStatus("Finishing conversation");
      await viz.disconnect();
      return;
    }
    const attempt = ++connectionAttempt.current;
    setConnectionPhase("connecting");
    setStatus("Connecting");
    try {
      await viz.connect(endpoint, { responseTiming, speechRate });
      if (attempt !== connectionAttempt.current) return;
      setConnectionPhase("connected");
      setStatus("Connected");
    } catch (error) {
      if (attempt !== connectionAttempt.current) return;
      setConnectionPhase("disconnected");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!snapshot.lastMessage) return;
    setLiveMessage(snapshot.lastMessage);
  }, [snapshot.lastMessage]);

  const model = {
    libraryItem,
    detailsOpen,
    theme,
    bookmarked,
    setLibraryItem,
    setDetailsOpen,
    setTheme,
    setBookmarked,
  };

  return (
    <div className="voice-app">
      <header>
        <p className="kicker">Jarvis voice-first demo</p>
        <h1>Speak to the page.</h1>
        <p className="intro">Ordinary questions stay in conversation. A UI request becomes one request_ui_changes call, and the voice runner interprets each sentence against the controls on screen before the registry runs it.</p>
      </header>

      <div className="toolbar" role="group" aria-label="Source">
        <button type="button" className={mode === "simulation" ? "active" : ""} disabled={voiceBusy} onClick={() => selectMode("simulation")}>Simulation</button>
        {LIVE_SOURCES.map((source) => (
          <button key={source.mode} type="button" className={mode === source.mode ? "active" : ""} disabled={voiceBusy} onClick={() => selectMode(source.mode)}>{source.label}</button>
        ))}
        <span>{status}</span>
      </div>

      {mode === "simulation" ? (
        <div className="scripts" role="group" aria-label="Simulation scripts">
          {VOICE_DEMO_SCRIPTS.map((script) => (
            <button
              key={script.id}
              type="button"
              disabled={voiceBusy}
              onClick={() => demoTransportRef.current?.playScript(script.id)}
            >
              {script.label}
            </button>
          ))}
        </div>
      ) : (
        <section className="session" aria-label="Live session">
          <label>
            Session endpoint
            <input value={endpoint} disabled={settingsLocked} onChange={(event) => setEndpoint(event.currentTarget.value)} />
          </label>
          <label>
            Response timing
            <select value={responseTiming} disabled={settingsLocked} onChange={(event) => {
              const next = RESPONSE_TIMINGS.find((timing) => timing.value === event.currentTarget.value);
              if (next) setResponseTiming(next.value);
            }}>
              {RESPONSE_TIMINGS.map((timing) => <option key={timing.value} value={timing.value}>{timing.label}</option>)}
            </select>
          </label>
          <label>
            Speaking pace
            <input
              type="range"
              min="0.75"
              max="1.25"
              step="0.05"
              value={speechRate}
              disabled={settingsLocked}
              onInput={(event) => {
                const next = event.currentTarget.valueAsNumber;
                setSpeechRate(next);
              }}
            />
          </label>
          <button type="button" disabled={(connectionPhase === "connecting" || connectionPhase === "closing") || voiceBusy} onClick={() => void toggleLiveConnection()}>
            {connectionPhase === "closing" ? "Finishing…" : connectionPhase === "connecting" ? "Connecting…" : connectionPhase === "connected" ? "Disconnect" : "Connect"}
          </button>
        </section>
      )}

      <nav className="routes" aria-label="App routes">
        {ROUTES.map((item) => (
          <a
            key={item}
            href={`#/${item}`}
            aria-current={route === item ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              void router.navigate(item);
            }}
          >
            {item}
          </a>
        ))}
      </nav>

      <div className="app-shell">
        <div>
          <NavigationCapability registry={registry} route={route} navigate={(next) => router.navigate(next)} />
          <RoutePage route={route} registry={registry} model={model} />
        </div>
        <aside className="side">
          <div className="stage" ref={mountRef} aria-hidden="true" />
          <section className="activity" aria-label="Interaction activity">
            <h2>Activity</h2>
            <dl>
              <dt>Phase</dt>
              <dd data-testid="activity-state">{snapshot.phase}</dd>
              <dt>Call</dt>
              <dd>{snapshot.callId ?? "none"}</dd>
              <dt>Request</dt>
              <dd data-testid="activity-request">{snapshot.request ?? "none"}</dd>
              <dt>Results</dt>
              <dd data-testid="activity-results">{snapshot.reports.map((report) => report.status).join(", ") || "none"}</dd>
              <dt>Result</dt>
              <dd data-testid="activity-result">{snapshot.lastMessage ?? "none"}</dd>
              {snapshot.timing.addedMs === undefined ? null : (<><dt>Added</dt><dd data-testid="activity-added">{snapshot.timing.addedMs} ms</dd></>)}
              {snapshot.timing.interpretMs === undefined ? null : (<><dt>Interpret</dt><dd>{snapshot.timing.interpretMs} ms</dd></>)}
              {snapshot.timing.executeMs === undefined ? null : (<><dt>Execute</dt><dd>{snapshot.timing.executeMs} ms</dd></>)}
            </dl>
          </section>
          <section className="transcript-wrap">
            {transcriptStore ? <TranscriptView store={transcriptStore} height={220} className="transcript-view" /> : <p>No transcript yet.</p>}
          </section>
        </aside>
      </div>
      <p className="live" aria-live="polite">{liveMessage}</p>
    </div>
  );
}
