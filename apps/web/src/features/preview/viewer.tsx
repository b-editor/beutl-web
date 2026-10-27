"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Expand, Minimize, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { cn } from "@beutl/core";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Slider } from "@beutl/ui/ui/slider";
import { useTranslation } from "@beutl/ui/i18n-client";
import { PreviewConnection, type ConnectionStatus, type PlaybackState, type PreviewAction } from "./connection";

function time(seconds: number, fraction = false) {
  const ticks = Math.round(Math.abs(seconds) * 100), minutes = Math.floor(ticks / 6000);
  const second = fraction ? ((ticks % 6000) / 100).toFixed(2).padStart(5, "0") : String(Math.floor(ticks % 6000 / 100)).padStart(2, "0");
  return `${seconds < 0 ? "−" : ""}${minutes}:${second}`;
}

export function PreviewViewer({ lang, basePath }: { lang: string; basePath: string }) {
  const { i18n } = useTranslation(lang);
  // The initial server render must use the URL language before client effects run.
  const t = i18n.getFixedT(lang);
  const video = useRef<HTMLVideoElement>(null);
  const viewer = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const connection = useRef<PreviewConnection | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [notice, setNotice] = useState("");
  const [range, setRange] = useState("SDR");
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairStatus, setPairStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [wantsAudio, setWantsAudio] = useState(false);
  const [seeking, setSeeking] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [playback, setPlayback] = useState<PlaybackState>({
    playing: false, position: 0, minimum: 0, duration: 0, frameRate: 30, enabled: false,
  });
  const connected = status === "connected";
  const canControl = connected && playback.enabled && !busy;
  const position = seeking ?? playback.position;
  const message = notice || (connected || status === "pair" ? "" : status === "disconnected" ? "connecting" : status);
  const showControls = () => { setControlsVisible(true); setActivity(value => value + 1); };

  useEffect(() => {
    let active = true;
    const session = new PreviewConnection(video.current!, basePath, update => {
      if (!active) return;
      if (update.type === "playback") setPlayback(current => ({ ...current, ...update }));
      else if (update.type === "range") setRange(update.range);
      else if (update.type === "audioFailed") { setNotice("audioFailed"); setControlsVisible(true); }
      else {
        setStatus(update.type);
        setNotice("");
        setSeeking(null);
      }
    });
    connection.current = session;
    const onVisibility = () => { if (document.hidden) session.close(); else void session.connect(); };
    const onPageHide = () => session.close();
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void session.connect(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    void session.connect();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      session.close();
      connection.current = null;
    };
  }, [basePath]);

  useEffect(() => {
    setControlsVisible(true);
    if (!connected || !playback.playing || busy || seeking !== null || message) return;
    const timer = setTimeout(() => {
      if (!controls.current?.querySelector(":focus-visible")) setControlsVisible(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [connected, playback.playing, busy, seeking, message, activity]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  async function pair(event: FormEvent) {
    event.preventDefault();
    setPairing(true); setPairStatus("connecting");
    try {
      const response = await fetch(basePath + "api/pair", { method: "POST", body: code, signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        setPairStatus("");
        if (connection.current) { connection.current.ended = false; await connection.current.connect(); }
      } else setPairStatus(response.status === 429 ? "limited" : response.status === 409 ? "full" : response.status === 410 ? "ended" : "invalid");
    } catch {
      // The pairing form remains usable after a temporary network failure.
      setPairStatus("reconnecting");
    } finally { setPairing(false); }
  }

  async function control(action: PreviewAction, target?: number) {
    if (!canControl || !connection.current) return;
    setBusy(true);
    try {
      const ok = await connection.current.control(action, target);
      setNotice(ok ? "" : "controlFailed");
    } finally { setBusy(false); setSeeking(null); showControls(); }
  }

  async function toggleAudio() {
    const enabled = !wantsAudio;
    video.current!.muted = !enabled;
    setWantsAudio(enabled);
    try { await video.current!.play(); setNotice(""); }
    catch {
      // Browsers can require another user gesture to start media playback.
      video.current!.muted = true; setWantsAudio(false); setNotice("audioFailed");
    }
    showControls();
  }

  async function toggleFullscreen() {
    try {
      if (immersive) setImmersive(false);
      else if (document.fullscreenElement) await document.exitFullscreen();
      else await viewer.current!.requestFullscreen();
    } catch {
      // iOS and embedded browsers may only support a viewport-filling fallback.
      setImmersive(value => !value);
    }
    showControls();
  }

  const hideControls = () => {
    if (connected && playback.playing && !busy && seeking === null && !message
      && !controls.current?.querySelector(":focus-visible")) setControlsVisible(false);
  };
  const buttonClass = "size-11 text-white hover:bg-white/10 hover:text-white [&_svg]:size-5";
  return <>
    {status === "pair" && <main id="pairing" className="grid min-h-dvh place-items-center px-7 py-6">
      <form id="pair-form" onSubmit={pair} className="grid w-full max-w-80 gap-4">
        <div className="mb-4 flex items-center gap-2.5 text-xl font-semibold tracking-tight">
          {/* Use the same brand asset as the rest of Beutl Web. */}
          <img src="/img/logo_dark.svg" width={28} height={28} alt="" /><span>Beutl</span>
        </div>
        <h1 id="pair-title" className="text-2xl font-semibold">{t("preview:code")}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("preview:instructions")}</p>
        <Input id="code" value={code} onChange={event => setCode(event.target.value)} name="code"
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          placeholder="000000" aria-labelledby="pair-title" aria-describedby="pair-status" required
          className="h-14 bg-card text-center text-3xl tabular-nums tracking-[0.2em] md:text-3xl" />
        <Button id="pair-button" type="submit" disabled={pairing} className="h-11">{t("preview:connect")}</Button>
        <p id="pair-status" role="status" aria-live="polite" hidden={!pairStatus}
          className={cn("text-sm", pairStatus === "connecting" ? "text-muted-foreground" : "text-destructive")}>{pairStatus && t(`preview:${pairStatus}`)}</p>
      </form>
    </main>}
    <section id="viewer" ref={viewer} hidden={status === "pair"} aria-label={t("preview:title")}
      tabIndex={0} onFocus={event => { if (event.currentTarget.matches(":focus-visible")) showControls(); }}
      className={cn("relative h-dvh overflow-hidden bg-black text-white focus-visible:outline-2 focus-visible:-outline-offset-2", immersive && "fixed inset-0 z-50")}
      onPointerMove={event => { if (event.pointerType === "mouse") showControls(); }}
      onKeyDown={event => {
        showControls();
        if (event.key === "Escape") setImmersive(false);
        if (event.code === "Space" && !(event.target as Element).closest("input,button,[role=slider]")) {
          event.preventDefault(); void control(playback.playing ? "pause" : "play");
        }
      }}>
      <video id="frame" ref={video} autoPlay playsInline muted={!wantsAudio} disablePictureInPicture
        className="absolute inset-0 size-full object-contain" onClick={() => controlsVisible ? hideControls() : showControls()} />
      <div id="connection" role="status" aria-live="polite" hidden={!message}
        className="absolute left-1/2 top-1/2 w-max max-w-[min(360px,calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-card/95 px-5 py-4 text-center text-sm leading-relaxed">
        {message && t(`preview:${message}`)}
        {status === "error" && <Button variant="secondary" className="mt-3 block w-full" onClick={() => void connection.current?.connect()}>{t("preview:retry")}</Button>}
      </div>
      <div id="controls" ref={controls} inert={!controlsVisible}
        onPointerDown={showControls} onFocusCapture={showControls} onBlur={showControls}
        className={cn("absolute bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 w-[min(720px,calc(100%-32px))] -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900/90 px-3 pb-2 pt-2.5 transition-opacity motion-reduce:transition-none",
          !controlsVisible && "pointer-events-none opacity-0")}>
        <div className="flex min-h-7 items-center gap-3">
          <Slider id="seek" aria-label={t("preview:seek")} aria-valuetext={time(position, true)}
            min={playback.minimum} max={Math.max(playback.minimum, playback.duration)} step={1 / playback.frameRate}
            value={[position]} disabled={!canControl || playback.duration <= playback.minimum}
            onValueChange={value => setSeeking(value[0])} onValueCommit={value => void control("seek", value[0])}
            onPointerCancel={() => setSeeking(null)} className="h-6 min-w-0 flex-1" />
          <output id="time" className="shrink-0 whitespace-nowrap text-center text-xs tabular-nums text-white/75">{time(position, true)} / {time(playback.duration)}</output>
          {range === "HDR" && <span id="range" className="text-xs font-semibold text-white/60">HDR</span>}
        </div>
        <div className="flex items-center gap-1">
          <div className="mr-auto flex items-center">
            <Button id="previous" type="button" variant="ghost" size="icon" className={buttonClass} aria-label={t("preview:previous")} disabled={!canControl} onClick={() => void control("previous")}><SkipBack /></Button>
            <Button id="play" type="button" variant="ghost" size="icon" className={buttonClass} aria-label={t(playback.playing ? "preview:pause" : "preview:play")} disabled={!canControl} onClick={() => void control(playback.playing ? "pause" : "play")}>
              {playback.playing ? <Pause /> : <Play />}
            </Button>
            <Button id="next" type="button" variant="ghost" size="icon" className={buttonClass} aria-label={t("preview:next")} disabled={!canControl} onClick={() => void control("next")}><SkipForward /></Button>
          </div>
          <Button id="audio" type="button" variant="ghost" size="icon" className={buttonClass} aria-label={t(wantsAudio ? "preview:audioOff" : "preview:audioOn")} aria-pressed={wantsAudio} disabled={!connected} onClick={() => void toggleAudio()}>{wantsAudio ? <Volume2 /> : <VolumeX />}</Button>
          <Button id="fullscreen" type="button" variant="ghost" size="icon" className={buttonClass} aria-label={t(fullscreen || immersive ? "preview:exitFullscreen" : "preview:fullscreen")} onClick={() => void toggleFullscreen()}>{fullscreen || immersive ? <Minimize /> : <Expand />}</Button>
        </div>
      </div>
    </section>
  </>;
}
