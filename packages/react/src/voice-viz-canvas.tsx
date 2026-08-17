import { useEffect, useRef, type CSSProperties } from "react";
import { VoiceViz, type VoiceVizOptions } from "@jarvis-viz/core";

export interface VoiceVizCanvasProps {
  options?: VoiceVizOptions;
  tokenEndpoint?: string;
  autoConnect?: boolean;
  className?: string;
  style?: CSSProperties;
  onReady?: (instance: VoiceViz) => void;
  onError?: (error: Error) => void;
}

export function VoiceVizCanvas({ options, tokenEndpoint, autoConnect = false, className, style, onReady, onError }: VoiceVizCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<VoiceViz | undefined>(undefined);
  const readyRef = useRef(onReady);
  const errorRef = useRef(onError);
  readyRef.current = onReady;
  errorRef.current = onError;

  const transport = options?.transport;
  const featureSource = options?.featureSource;
  const locale = options?.locale;
  const reducedMotion = options?.reducedMotion;
  const panelBreakpoint = options?.panelBreakpoint;
  const theme = options?.theme;
  const presets = options?.presets;
  const panelPlacement = options?.panelPlacement;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const instance = new VoiceViz({
      ...(transport ? { transport } : {}),
      ...(featureSource ? { featureSource } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(reducedMotion !== undefined ? { reducedMotion } : {}),
      ...(panelBreakpoint !== undefined ? { panelBreakpoint } : {}),
      ...(theme !== undefined ? { theme } : {}),
      ...(presets !== undefined ? { presets } : {}),
      ...(panelPlacement !== undefined ? { panelPlacement } : {}),
    });
    instance.mount(mount);
    instanceRef.current = instance;
    const offError = instance.on("error", ({ error }) => errorRef.current?.(error));
    readyRef.current?.(instance);
    return () => {
      offError();
      instance.unmount();
      if (instanceRef.current === instance) instanceRef.current = undefined;
    };
  }, [featureSource, locale, panelBreakpoint, reducedMotion, transport]);

  useEffect(() => { if (theme) instanceRef.current?.setTheme(theme); }, [theme]);
  useEffect(() => { if (presets) instanceRef.current?.setPresets(presets); }, [presets]);
  useEffect(() => { if (panelPlacement) instanceRef.current?.setPanelPlacement(panelPlacement); }, [panelPlacement]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    if (!autoConnect || !tokenEndpoint) {
      if (instance.connected) instance.disconnect();
      return;
    }
    let active = true;
    void instance.connect(tokenEndpoint).catch((error: unknown) => {
      if (active) errorRef.current?.(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      active = false;
    };
  }, [autoConnect, featureSource, locale, panelBreakpoint, reducedMotion, tokenEndpoint, transport]);

  return <div ref={mountRef} className={className} style={{ minWidth: 0, minHeight: 0, ...style }} />;
}
