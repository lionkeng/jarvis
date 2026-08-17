import { useEffect, useRef, useState } from "react";
import { themes, VoiceViz, type PanelPlacement, type PresetName, type ResponseTiming, type TextMotion, type ThemeName, type TranscriptMessage, type TranscriptStore } from "@jarvis-viz/core";
import { TranscriptView } from "@jarvis-viz/react";
import { DemoTransport, DemoVoiceFeatureSource } from "./demo-transport.js";

const PRESETS: PresetName[] = ["bars", "waveform", "ring", "particles", "hud"];
const RESPONSE_TIMINGS: ReadonlyArray<{ value: ResponseTiming; label: string; detail: string }> = [
  { value: "fast", label: "Fast", detail: "Eager turn detection, minimal reasoning, low transcript delay." },
  { value: "natural", label: "Natural", detail: "Balanced turn detection, low reasoning, medium transcript delay." },
  { value: "patient", label: "Patient", detail: "Longer turn detection, medium reasoning, high transcript delay." },
];
type ConnectionPhase = "disconnected" | "connecting" | "connected";

interface StageProps {
  label: string;
  detail: string;
  className: string;
  mountRef: (node: HTMLDivElement | null) => void;
}

function Stage({ label, detail, className, mountRef }: StageProps) {
  return (
    <section className="stage-block">
      <header className="stage-label"><strong>{label}</strong><span>{detail}</span></header>
      <div className={`stage ${className}`} ref={mountRef} />
    </section>
  );
}

export function App() {
  const hosts = useRef<Array<HTMLDivElement | null>>([]);
  const instances = useRef<VoiceViz[]>([]);
  const connectionAttempt = useRef(0);
  const [mode, setMode] = useState<"simulation" | "live">("simulation");
  const [theme, setTheme] = useState<ThemeName>("cyan");
  const [textMotion, setTextMotion] = useState<TextMotion>("flow");
  const [placement, setPlacement] = useState<PanelPlacement>("auto");
  const [presets, setPresets] = useState<PresetName[]>(PRESETS);
  const [endpoint, setEndpoint] = useState("http://localhost:3001/session");
  const [responseTiming, setResponseTiming] = useState<ResponseTiming>("natural");
  const [speechRate, setSpeechRate] = useState(1);
  const [messages, setMessages] = useState<readonly TranscriptMessage[]>([]);
  const [transcriptStore, setTranscriptStore] = useState<TranscriptStore | undefined>(undefined);
  const [status, setStatus] = useState("Ready");
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>("disconnected");
  const settingsLocked = connectionPhase !== "disconnected";
  const timingDetail = RESPONSE_TIMINGS.find(({ value }) => value === responseTiming)?.detail ?? RESPONSE_TIMINGS[1]!.detail;

  useEffect(() => {
    const transcriptUnsubscribes: Array<() => void> = [];
    const active = hosts.current.flatMap((host, index) => {
      if (!host) return [];
      const useLiveTransport = mode === "live" && index === 1;
      const signal = useLiveTransport ? undefined : new DemoVoiceFeatureSource();
      const transport = signal ? { transport: new DemoTransport(signal), featureSource: signal } : {};
      const viz = new VoiceViz({
        ...transport,
        presets,
        theme: { ...themes[theme], textMotion },
        panelPlacement: placement,
      });
      viz.mount(host);
      viz.on("statechange", ({ state }) => { if (index === 1) setStatus(state); });
      viz.on("error", ({ error }) => {
        if (index !== 1) return;
        connectionAttempt.current += 1;
        setConnectionPhase("disconnected");
        setStatus(error.message);
      });
      if (index === 1) {
        setTranscriptStore(viz.transcript);
        setMessages(viz.transcript.getSnapshot().messages);
        transcriptUnsubscribes.push(viz.transcript.subscribe((snapshot) => setMessages(snapshot.messages)));
      }
      if (!useLiveTransport) void viz.connect("demo");
      return [viz];
    });
    instances.current = active;
    return () => {
      for (const unsubscribe of transcriptUnsubscribes) unsubscribe();
      for (const instance of active) instance.unmount();
      instances.current = [];
    };
  }, [mode]);

  useEffect(() => { for (const instance of instances.current) instance.setTheme({ ...themes[theme], textMotion }); }, [textMotion, theme]);
  useEffect(() => { for (const instance of instances.current) instance.setPanelPlacement(placement); }, [placement]);
  useEffect(() => { for (const instance of instances.current) instance.setPresets(presets); }, [presets]);

  const togglePreset = (preset: PresetName) => setPresets((current) => current.includes(preset) ? current.filter((value) => value !== preset) : [...current, preset]);
  const changeSpeechRate = (nextRate: number) => {
    setSpeechRate(nextRate);
    instances.current[1]?.setTranscriptPace(nextRate);
  };
  const selectMode = (nextMode: "simulation" | "live") => {
    if (nextMode === mode) return;
    connectionAttempt.current += 1;
    setConnectionPhase("disconnected");
    setStatus(nextMode === "live" ? "Ready" : "idle");
    setMode(nextMode);
  };
  const toggleLiveConnection = async () => {
    const primary = instances.current[1];
    if (!primary || connectionPhase === "connecting") return;
    if (connectionPhase === "connected" || primary.connected) {
      connectionAttempt.current += 1;
      primary.disconnect();
      setConnectionPhase("disconnected");
      setStatus("Disconnected");
      return;
    }

    const attempt = ++connectionAttempt.current;
    primary.setTranscriptPace(speechRate);
    setConnectionPhase("connecting");
    setStatus("Connecting");
    try {
      await primary.connect(endpoint, { responseTiming, speechRate });
      if (attempt !== connectionAttempt.current) return;
      setConnectionPhase("connected");
      setStatus("Connected · idle");
    } catch (error) {
      if (attempt !== connectionAttempt.current) return;
      setConnectionPhase("disconnected");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main>
      <header className="masthead">
        <div><p className="kicker">Jarvis voice visualization</p><h1>Realtime signal lab</h1></div>
        <p className="intro">Inspect one visualization system across compact, standard, and fluid hosts. Switch presets without restarting the session.</p>
      </header>

      <section className="controls" aria-label="Visualization controls">
        <div className="control-group">
          <span className="control-label">Source</span>
          <div className="segmented">
            <button className={mode === "simulation" ? "active" : ""} onClick={() => selectMode("simulation")}>Simulation</button>
            <button className={mode === "live" ? "active" : ""} onClick={() => selectMode("live")}>OpenAI live</button>
          </div>
        </div>
        <label className="control-group"><span className="control-label">Theme</span><select value={theme} onChange={(event) => setTheme(event.currentTarget.value as ThemeName)}><option value="cyan">Cyan</option><option value="amber">Amber</option><option value="rose">Rose</option><option value="spectrum">Spectrum</option><option value="coast">Coast</option><option value="ultraviolet">Ultraviolet</option><option value="magenta">Magenta</option></select></label>
        <label className="control-group"><span className="control-label">Text motion</span><select value={textMotion} onChange={(event) => setTextMotion(event.currentTarget.value as TextMotion)}><option value="flow">Flow</option><option value="kinetic">Kinetic</option></select></label>
        <label className="control-group"><span className="control-label">Panel</span><select value={placement} onChange={(event) => setPlacement(event.currentTarget.value as PanelPlacement)}><option value="auto">Auto</option><option value="side">Side</option><option value="bottom">Bottom</option></select></label>
        <div className="control-group preset-control"><span className="control-label">Layers</span><div className="checks">{PRESETS.map((preset) => <label key={preset}><input type="checkbox" checked={presets.includes(preset)} onChange={() => togglePreset(preset)} />{preset}</label>)}</div></div>
      </section>

      {mode === "live" ? (
        <section className="live-connect" aria-labelledby="live-connect-title">
          <header className="live-connect-header">
            <h2 id="live-connect-title">Live voice pacing</h2>
            <p>Calibrate how quickly the agent takes the turn and how fast it speaks.</p>
          </header>

          <div className="session-settings">
            <label className="session-field endpoint-field">
              <span className="field-title">Bun session endpoint</span>
              <input value={endpoint} disabled={settingsLocked} onChange={(event) => setEndpoint(event.currentTarget.value)} />
              <span className="field-help">Server-minted ephemeral session</span>
            </label>

            <fieldset className="session-field timing-field" disabled={settingsLocked}>
              <legend className="field-title">Response timing</legend>
              <div className="timing-options">
                {RESPONSE_TIMINGS.map(({ value, label }) => (
                  <label className="timing-option" key={value}>
                    <input
                      type="radio"
                      name="response-timing"
                      value={value}
                      checked={responseTiming === value}
                      onChange={() => setResponseTiming(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <p className="field-help" aria-live="polite">{timingDetail}</p>
            </fieldset>

            <label className="session-field speech-rate-field">
              <span className="rate-heading">
                <span className="field-title">Speech speed</span>
                <output htmlFor="speech-rate">{speechRate.toFixed(2)}×</output>
              </span>
              <input
                id="speech-rate"
                type="range"
                min="0.75"
                max="1.25"
                step="0.05"
                value={speechRate}
                disabled={settingsLocked}
                aria-describedby="speech-rate-help"
                onInput={(event) => changeSpeechRate(event.currentTarget.valueAsNumber)}
              />
              <span className="rate-scale" aria-hidden="true"><span>Measured</span><span>Brisk</span></span>
              <span className="field-help" id="speech-rate-help">The agent transcript follows this rate.</span>
            </label>
          </div>

          <footer className="live-connect-actions">
            <p>Settings lock while connected. Microphone capture is limited to the standard host.</p>
            <button
              className="connect"
              data-connected={connectionPhase === "connected"}
              disabled={connectionPhase === "connecting"}
              aria-pressed={connectionPhase === "connected"}
              onClick={toggleLiveConnection}
            >
              {connectionPhase === "connecting" ? "Connecting…" : connectionPhase === "connected" ? "Disconnect primary" : "Connect primary"}
            </button>
          </footer>
        </section>
      ) : null}

      <div className="status-line"><span>Primary state</span><strong>{status}</strong></div>

      <div className="stages">
        <Stage label="Compact host" detail="320 × 200" className="stage-compact" mountRef={(node) => { hosts.current[0] = node; }} />
        <Stage label="Standard host" detail="800 × 600" className="stage-standard" mountRef={(node) => { hosts.current[1] = node; }} />
        <Stage label="Fluid host" detail="Container width" className="stage-fluid" mountRef={(node) => { hosts.current[2] = node; }} />
      </div>

      <section className="transcript" aria-label="Primary transcript">
        <header><h2>Conversation transcript</h2><span>{messages.length} messages</span></header>
        {transcriptStore ? <TranscriptView store={transcriptStore} height={320} className="transcript-view" /> : <p className="empty">Start the simulation or connect a live session to populate the transcript.</p>}
      </section>
    </main>
  );
}
