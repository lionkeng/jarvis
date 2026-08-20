import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useActorRef, useSelector } from "@xstate/react";
import { VoiceViz, type RealtimeToolResult, type ResponseTiming, type TranscriptStore } from "@jarvis-viz/core";
import { TranscriptView } from "@jarvis-viz/react";
import { UiCapabilityRegistry } from "./capability-registry.js";
import { createHashRouter } from "./hash-router.js";
import { INTERACTION_QUEUE_LIMIT } from "./interaction-contract.js";
import { interactionMachine, selectVoiceWorkPending } from "./interaction-machine.js";
import { NavigationCapability, RoutePage, sendTyped, type LibraryItem, type ThemeChoice } from "./pages.js";
import { VOICE_DEMO_SCRIPTS, VoiceDemoTransport } from "./voice-demo-transport.js";
import { DemoVoiceFeatureSource } from "../demo-transport.js";

type ConnectionPhase = "disconnected" | "connecting" | "connected";
const RESPONSE_TIMINGS: ReadonlyArray<{ value: ResponseTiming; label: string }> = [
  { value: "fast", label: "Fast" },
  { value: "natural", label: "Natural" },
  { value: "patient", label: "Patient" },
];
const ROUTES = ["dashboard", "library", "article", "settings"] as const;

export function VoiceApp() {
  const registry = useRef(new UiCapabilityRegistry()).current;
  const router = useRef(createHashRouter()).current;
  const vizRef = useRef<VoiceViz | undefined>(undefined);
  const demoTransportRef = useRef<VoiceDemoTransport | undefined>(undefined);
  const submitImpl = useRef<(result: RealtimeToolResult) => void>(() => undefined);
  const resultPort = useRef({ submit: (result: RealtimeToolResult) => submitImpl.current(result) }).current;
  const actorInput = useRef({ registry, resultPort }).current;
  const actor = useActorRef(interactionMachine, { input: actorInput });
  const connectionAttempt = useRef(0);
  const mountRef = useRef<HTMLDivElement | null>(null);

  const route = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);
  const activity = useSelector(actor, (snapshot) => ({
    state: typeof snapshot.value === "string" ? snapshot.value : "ready",
    callId: snapshot.context.active?.source === "voice" ? snapshot.context.active.call.callId : undefined,
    commands: snapshot.context.commands,
    applied: snapshot.context.applied,
    result: snapshot.context.lastResult,
    voiceBusy: selectVoiceWorkPending(snapshot),
    queueFull: snapshot.context.queue.length >= INTERACTION_QUEUE_LIMIT,
  }));

  const [mode, setMode] = useState<"simulation" | "live">("simulation");
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

  const settingsLocked = connectionPhase !== "disconnected" || activity.voiceBusy;
  const controlsLocked = activity.voiceBusy || activity.queueFull;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => () => router.dispose(), [router]);

  useEffect(() => {
    submitImpl.current = (result) => {
      vizRef.current?.submitToolResult(result);
    };
  });

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const signal = mode === "simulation" ? new DemoVoiceFeatureSource() : undefined;
    const transport = signal ? new VoiceDemoTransport(signal) : undefined;
    demoTransportRef.current = transport;
    const viz = new VoiceViz({
      ...(transport && signal ? { transport, featureSource: signal } : {}),
      presets: ["ring", "hud"],
      reducedMotion,
    });
    viz.mount(host);
    vizRef.current = viz;
    setTranscriptStore(viz.transcript);
    const unsubTool = viz.on("toolcall", (call) => {
      actor.send({ type: "TOOL_CALL_RECEIVED", call });
    });
    const unsubState = viz.on("statechange", ({ state }) => {
      setStatus(state);
      const snapshot = actor.getSnapshot();
      if (state === "listening" && (snapshot.matches("validating") || snapshot.matches("executing"))) {
        actor.send({ type: "VOICE_INTERRUPTED" });
      }
    });
    const unsubError = viz.on("error", ({ error }) => {
      connectionAttempt.current += 1;
      setConnectionPhase("disconnected");
      setStatus(error.message);
      setLiveMessage(error.message);
      actor.send({ type: "SESSION_DISCONNECTED" });
    });
    if (transport) void viz.connect("demo");
    return () => {
      unsubTool();
      unsubState();
      unsubError();
      viz.unmount();
      vizRef.current = undefined;
      demoTransportRef.current = undefined;
      setTranscriptStore(undefined);
    };
  }, [actor, mode]);

  const selectMode = (nextMode: "simulation" | "live") => {
    if (nextMode === mode || activity.voiceBusy) return;
    connectionAttempt.current += 1;
    setConnectionPhase("disconnected");
    setStatus(nextMode === "live" ? "Ready" : "idle");
    setMode(nextMode);
  };

  const toggleLiveConnection = async () => {
    const viz = vizRef.current;
    if (!viz || connectionPhase === "connecting" || activity.voiceBusy) return;
    if (connectionPhase === "connected" || viz.connected) {
      connectionAttempt.current += 1;
      viz.disconnect();
      setConnectionPhase("disconnected");
      setStatus("Disconnected");
      actor.send({ type: "SESSION_DISCONNECTED" });
      return;
    }
    const attempt = ++connectionAttempt.current;
    viz.setTranscriptPace(speechRate);
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
    if (!activity.result) return;
    setLiveMessage(activity.result.message);
  }, [activity.result]);

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
        <p className="intro">Ordinary questions stay in conversation. UI requests become a bounded perform_ui_actions call, then an XState actor runs registered page capabilities.</p>
      </header>

      <div className="toolbar" role="group" aria-label="Source">
        <button type="button" className={mode === "simulation" ? "active" : ""} disabled={activity.voiceBusy} onClick={() => selectMode("simulation")}>Simulation</button>
        <button type="button" className={mode === "live" ? "active" : ""} disabled={activity.voiceBusy} onClick={() => selectMode("live")}>OpenAI live</button>
        <span>{status}</span>
      </div>

      {mode === "simulation" ? (
        <div className="scripts" role="group" aria-label="Simulation scripts">
          {VOICE_DEMO_SCRIPTS.map((script) => (
            <button
              key={script.id}
              type="button"
              disabled={controlsLocked}
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
            Speech speed
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
                vizRef.current?.setTranscriptPace(next);
              }}
            />
          </label>
          <button type="button" disabled={connectionPhase === "connecting" || activity.voiceBusy} onClick={() => void toggleLiveConnection()}>
            {connectionPhase === "connecting" ? "Connecting…" : connectionPhase === "connected" ? "Disconnect" : "Connect"}
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
              if (controlsLocked) return;
              sendTyped(actor, [{ type: "navigate", route: item }]);
            }}
          >
            {item}
          </a>
        ))}
      </nav>

      <div className="app-shell">
        <div>
          <NavigationCapability registry={registry} routerNavigate={(next) => router.navigate(next)} />
          <RoutePage route={route} registry={registry} actor={actor} model={model} />
        </div>
        <aside className="side">
          <div className="stage" ref={mountRef} aria-hidden="true" />
          <section className="activity" aria-label="Interaction activity">
            <h2>Activity</h2>
            <dl>
              <dt>Lifecycle</dt>
              <dd data-testid="activity-state">{activity.state}</dd>
              <dt>Call</dt>
              <dd>{activity.callId ?? "none"}</dd>
              <dt>Commands</dt>
              <dd>{activity.commands.map((command) => command.type).join(", ") || "none"}</dd>
              <dt>Applied</dt>
              <dd>{activity.applied.map((command) => command.type).join(", ") || "none"}</dd>
              <dt>Result</dt>
              <dd data-testid="activity-result">{activity.result?.message ?? "none"}</dd>
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
