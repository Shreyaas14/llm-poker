"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Info, LoaderCircle, Pause, Play, RotateCcw, X } from "lucide-react";
import type { Bootstrap, GameMode, Profile, SessionCommand, SessionView } from "./types";
import { MODEL_SEATS, PokerTable, type TableSeat } from "../components/river/PokerTable";
import { credits, MarketPanel, price, signed } from "../components/river/MarketPanel";
import { MarketAnalytics } from "../components/river/MarketAnalytics";
import { PositionsStrip } from "../components/river/PositionsStrip";
import { DEFAULT_PLAY_PACE, playbackDelay, scheduleAutoStep, type PlayPace } from "../lib/playback";
import { YourGames } from "../components/river/GameHistory";
import { TraderActivity } from "../components/river/TraderActivity";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers }, credentials: "same-origin" });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : "That request did not complete. Please try again.");
  return data as T;
}

export default function Home() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tradingBusy, setTradingBusy] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [tab, setTab] = useState<"table" | "leaderboard" | "games">("table");
  const [initialReplayId, setInitialReplayId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [boardMode, setBoardMode] = useState<GameMode>("practice");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [playbackChanging, setPlaybackChanging] = useState(false);
  const [pace, setPace] = useState<PlayPace>(DEFAULT_PLAY_PACE);
  const [countdown, setCountdown] = useState<number>(DEFAULT_PLAY_PACE);
  const sessionRef = useRef<SessionView | null>(null);
  const commandQueue = useRef<Promise<void>>(Promise.resolve());
  const commandCount = useRef(0);
  const marketQueue = useRef<Promise<void>>(Promise.resolve());
  const marketCount = useRef(0);
  const tickPending = useRef(false);
  const mounted = useRef(true);
  const playbackIntent = useRef(false);
  const playbackRequest = useRef<boolean | null>(null);

  const acceptSession = useCallback((next: SessionView) => {
    const previous = sessionRef.current;
    if (previous?.id === next.id && previous.version > next.version) return;
    sessionRef.current = next;
    if (mounted.current) {
      setSession(next);
      if (next.paused) setAutoPlay(false);
    }
  }, []);

  const loadBootstrap = useCallback(async () => {
    const data = await request<Bootstrap>("/api/bootstrap");
    if (mounted.current) { setBootstrap(data); setUsername(data.profile?.username ?? ""); }
    return data;
  }, []);

  const initialize = useCallback(async () => {
    try {
      const data = await loadBootstrap();
      if (data.activeSessionId) {
        let resumed = await request<SessionView>(`/api/session/${data.activeSessionId}`);
        acceptSession(resumed);
        if (resumed.status !== "complete" && !resumed.paused) {
          resumed = await request<SessionView>(`/api/session/${resumed.id}/command`, { method: "POST", body: JSON.stringify({ type: "playback", paused: true, requestId: crypto.randomUUID() }) });
        }
        acceptSession(resumed);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "The table could not be loaded."); }
    finally { if (mounted.current) setLoading(false); }
  }, [acceptSession, loadBootstrap]);

  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => { mounted.current = false; };
  }, [initialize]);

  const runCommand = useCallback(async (command: SessionCommand) => {
    const current = sessionRef.current;
    if (!current) return;
    const background = command.type === "tick";
    const poker = command.type === "advance" || command.type === "next_hand";
    const trading = command.type === "order" || command.type === "cancel";
    if (background && (tickPending.current || marketCount.current > 0)) return;
    if (background) tickPending.current = true;
    if (poker) { commandCount.current++; setBusy(true); }
    if (trading) { marketCount.current++; setTradingBusy(true); }
    if (!background) setError(null);
    if (command.type === "advance") setAdvancing(true);
    const queue = poker ? commandQueue : marketQueue;
    const action = queue.current.catch(() => {}).then(async () => {
      try {
        const next = await request<SessionView>(`/api/session/${current.id}/command`, { method: "POST", body: JSON.stringify({ ...command, requestId: crypto.randomUUID() }) });
        if (sessionRef.current?.id !== current.id) return;
        acceptSession(next);
        if (command.type === "playback") setAutoPlay(!next.paused && playbackIntent.current);
        if (!background) {
          const latest = next.activity.at(-1);
          setAnnouncement(command.type === "playback" ? next.paused ? "Game and market paused. Trading is disabled." : "Game and trading resumed." : command.type === "order" ? latest?.text ?? "Order submitted. Check your positions and open orders." : command.type === "cancel" ? "Order cancelled." : latest?.text ?? "The table has advanced.");
        }
        if (next.status === "complete" && current.status !== "complete") void loadBootstrap().catch(() => {});
      } catch (e) {
        if (!background && mounted.current) {
          setError(e instanceof Error ? e.message : "That action did not complete.");
          if (command.type === "advance" || command.type === "next_hand") {
            playbackIntent.current = false;
            setAutoPlay(false);
            try {
              const paused = await request<SessionView>(`/api/session/${current.id}/command`, { method: "POST", body: JSON.stringify({ type: "playback", paused: true, requestId: crypto.randomUUID() }) });
              if (sessionRef.current?.id === current.id) acceptSession(paused);
            } catch { /* The local pause still blocks trading and further automatic requests. */ }
          }
        }
      } finally {
        if (background) tickPending.current = false;
        if (poker) { commandCount.current--; if (mounted.current) setBusy(commandCount.current > 0); }
        if (trading) { marketCount.current--; if (mounted.current) setTradingBusy(marketCount.current > 0); }
        if (command.type === "advance" && mounted.current) setAdvancing(false);
      }
    });
    queue.current = action;
    await action;
  }, [acceptSession, loadBootstrap]);

  const changePlayback = useCallback(async (paused: boolean) => {
    const current = sessionRef.current;
    if (!current || current.status === "complete") return;
    playbackIntent.current = !paused;
    if (paused) setAutoPlay(false);
    if (playbackRequest.current === paused) return;
    playbackRequest.current = paused;
    setPlaybackChanging(true);
    await runCommand({ type: "playback", paused });
    if (playbackRequest.current === paused) {
      playbackRequest.current = null;
      setPlaybackChanging(false);
    }
  }, [runCommand]);

  const activeId = session?.id;
  const isPlaying = session?.status === "playing";
  useEffect(() => {
    if (!activeId || !isPlaying || !autoPlay) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void runCommand({ type: "tick" });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeId, isPlaying, autoPlay, runCommand]);

  // Realtime also resumes after a queued market update completes. Paced modes
  // only restart for poker changes so one-second ticks cannot reset the delay.
  const playbackRevision = pace === 0 ? session?.version : session?.pokerRevision;
  const gameStatus = session?.status;
  const realtimeBusy = pace === 0 && busy;
  useEffect(() => {
    if (!activeId || !autoPlay || realtimeBusy || tab !== "table" || profileOpen || confirmEnd || gameStatus === "complete") return;
    return scheduleAutoStep({
      pace, handComplete: gameStatus === "hand_complete",
      isBusy: () => Boolean(sessionRef.current?.busy),
      canAdvance: () => {
        const current = sessionRef.current;
        return document.visibilityState === "visible" && commandCount.current === 0
          && Boolean(current && !current.paused && playbackIntent.current && !current.busy && current.status !== "complete");
      },
      onCountdown: setCountdown,
      onAdvance: () => {
        const current = sessionRef.current;
        if (current) void runCommand({ type: current.status === "hand_complete" ? "next_hand" : "advance", pokerRevision: current.pokerRevision });
      },
    });
  }, [activeId, playbackRevision, gameStatus, autoPlay, pace, realtimeBusy, tab, profileOpen, confirmEnd, runCommand]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.visibilityState !== "visible") void changePlayback(true); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [changePlayback]);

  async function startGame(mode: GameMode, ranked: boolean, personalitiesEnabled: boolean) {
    setBusy(true); setError(null);
    try {
      await Promise.all([commandQueue.current, marketQueue.current]);
      const next = await request<SessionView>("/api/session", { method: "POST", body: JSON.stringify({ mode, ranked, personalitiesEnabled, requestId: crypto.randomUUID() }) });
      acceptSession(next); setTab("table"); playbackIntent.current = !next.paused; setAutoPlay(!next.paused); setCountdown(pace); setAnnouncement(next.paused ? "Challenge restored. Press Play to resume." : "Challenge started. The game and market are live.");
      void loadBootstrap().catch(() => {});
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start your challenge."); return false; }
    finally { setBusy(false); }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const profile = await request<Profile>("/api/profile", { method: "POST", body: JSON.stringify({ username: username.trim() }) });
      setBootstrap(previous => previous ? { ...previous, profile } : previous); setProfileOpen(false); setAnnouncement("Your username is saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Username could not be saved."); }
    finally { setBusy(false); }
  }

  async function endRun() {
    if (!session) return;
    playbackIntent.current = false; setAutoPlay(false); setBusy(true); setError(null);
    try {
      await Promise.all([commandQueue.current, marketQueue.current]);
      await request<{ ok: true }>(`/api/session/${session.id}`, { method: "DELETE", body: "{}" });
      sessionRef.current = null; setSession(null); setConfirmEnd(false);
      setAnnouncement("Run ended. You can start a new challenge.");
      await loadBootstrap();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not end this run."); }
    finally { setBusy(false); }
  }

  function newChallenge() { playbackIntent.current = false; setAutoPlay(false); sessionRef.current = null; setSession(null); setAnnouncement(""); setTab("table"); }
  function showRules() { void changePlayback(true); setRulesOpen(true); window.setTimeout(() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 0); }

  const seats: TableSeat[] = session ? session.players.map(p => ({ id: String(p.seat), name: p.name, cards: p.cards, stack: p.stack, action: p.allIn ? "All-in" : p.lastAction || "Waiting", folded: p.folded, active: session.actor === p.seat && session.status === "playing", dealer: p.seat === session.button, winner: session.winners.includes(p.seat), allIn: p.allIn, classId: p.classId, className: p.className, description: p.description })) : bootstrap?.models?.length ? bootstrap.models.map(m => ({ ...MODEL_SEATS[m.seat], id: String(m.seat), name: m.name })) : MODEL_SEATS;
  const latestPokerAction = session?.activity.filter(a => a.kind === "poker" && a.hand === session.hand).at(-1);
  const isComplete = session?.status === "complete";
  const thinking = advancing || Boolean(session?.busy);
  const isHandComplete = session?.status === "hand_complete";
  const pauseUnconfirmed = Boolean(session && !isComplete && !autoPlay && !session.paused && !playbackChanging);
  const leaderboard = boardMode === "live" ? bootstrap?.leaderboard ?? [] : bootstrap?.practiceLeaderboard ?? [];
  const pnl = session?.pnl ?? 0;
  const rules = <details className="rules-details" id="how-it-works" open={rulesOpen} onToggle={e => setRulesOpen(e.currentTarget.open)}><summary>How VESPER works</summary><div className="rules-content"><p><strong>The challenge:</strong> begin with 1,000 play-money credits and trade across five poker hands. You are a spectator and a trader; the four models are the poker players. Each new hand starts a new outcome market, and your credits carry forward.</p><p><strong>Your information:</strong> every dealt hole card is visible to you. The models only receive their own cards and the public table. Future community cards stay hidden until dealt. Personalities are off by default. Enable them before starting a challenge to shuffle four playing classes across the models: Shark, Bully, Maniac, and Opportunist. Classes stay assigned for all five hands. Hover, focus, or tap a class for its style; these are tendencies, so any model can still bluff or fold.</p><p><strong>The market:</strong> 16 synthetic traders place funded bids and asks and take actual positions when orders match. The trader panel shows holdings, net shares bought or sold, and recent executions. Makers begin each hand with 700 shares of every outcome; other traders begin with 240. These collateral-backed opening inventories are separate from their trades. A changed quote alone does not change anyone’s position; a fill does. At settlement, shares are redeemed and holdings return to zero. You can buy available shares at the shown ask, sell shares you own at the shown bid, or place a limit order. Orders can fill partly, and prices can change. Normal advances the game automatically after 6 seconds by default, or 3 seconds at Fast speed. Realtime advances as soon as each response completes, with no added pause between actions or hands. Entering and submitting orders keeps the game running. Pause freezes the game and market: no orders, cancellations, or synthetic fills occur until Play resumes them. Switching away from this tab also pauses play. You can submit and cancel orders while a model is deciding, until the hand settles. Your order keeps its maximum buy or minimum sell price as the table changes. Synthetic quote arrivals stop after 45 seconds without a new poker action. Unfilled immediate orders cancel; resting limit orders can carry across actions until filled, cancelled, or the hand settles.</p><p><strong>Settlement:</strong> a share in the sole main-pot winner pays 1 credit. If the main pot is tied, the winners split that credit equally. All other shares pay zero. Side-pot winners do not determine the contract. Outstanding orders cancel when the hand settles.</p><p><strong>Scoring:</strong> final PnL is your credits after five hands minus the starting 1,000. During play, account value uses available bids, so shares without buyers are conservatively marked at zero. Practice and live models have separate weekly leaderboards. Your best completed score from your first three ranked starts each week counts. Practice and live share that three-start allowance. An unfinished or abandoned ranked start still uses an attempt. Ranked challenges require sign-in and a username.</p><p><strong>Practice versus live:</strong> practice uses local decision models with a neutral policy, or distinct playing styles when personalities are enabled. Live mode calls the actual GPT, Claude, Gemini, and Grok providers when connected. This is a play-money game, with no deposits, withdrawals, or prizes.</p></div></details>;

  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to game</a>
    <header className="site-header"><Link className="brand" href="/" aria-label="VESPER home"><img className="brand-logo" src="/vesper-logo-transparent.png" alt="VESPER" width={1536} height={1024} /></Link><nav className="header-nav" aria-label="Main navigation"><button className={`nav-link ${tab === "table" ? "active" : ""}`} type="button" onClick={() => setTab("table")}>Table</button><button className={`nav-link ${tab === "leaderboard" ? "active" : ""}`} type="button" onClick={() => { void changePlayback(true); setTab("leaderboard"); }}>Leaderboard</button><button className="nav-link" type="button" onClick={showRules}>How to play</button><button className={`nav-link ${tab === "games" ? "active" : ""}`} type="button" onClick={() => { void changePlayback(true); setInitialReplayId(null); setTab("games"); }}>Your games</button></nav>{bootstrap?.authenticated ? <button className="user-button" type="button" onClick={() => { void changePlayback(true); setProfileOpen(!profileOpen); }} aria-expanded={profileOpen} aria-label="Open your profile">{bootstrap.profile?.username ?? "Your profile"}</button> : <a className="user-button" href="/signin-with-chatgpt?return_to=/" target="_top" aria-label="Sign in with ChatGPT">Sign in</a>}</header>
    <main id="main">
      <h1 className="sr-only">Poker prediction market</h1>
      {error ? <div className="error-banner" role="alert"><Info size={15} /><span>{error}{!bootstrap && !loading ? <button type="button" className="text-button" onClick={() => { setLoading(true); setError(null); void initialize(); }}>Retry connection <RotateCcw size={11} /></button> : null}</span><button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button></div> : null}
      {tab === "table" && session?.notice ? <div className="notice-banner"><Info size={14} /><span>{session.notice}</span></div> : null}
      {profileOpen ? <section className="settings-panel" aria-label="Your profile"><h2>Your profile</h2><p>Your public username appears on the weekly leaderboard. Three ranked starts per week are shared across both modes. {bootstrap?.profile ? `${bootstrap.profile.remainingAttempts} ranked attempts remaining this week.` : "Set one to enter ranked challenges."}</p><form onSubmit={saveProfile} className="profile-form"><div><label htmlFor="username">Public username</label><input className="text-input" id="username" autoComplete="nickname" minLength={3} maxLength={20} required value={username} onChange={e => setUsername(e.target.value)} placeholder="Your table name" /></div><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={12} className="loading-spinner" /> : <Check size={12} />}Save username</button></form></section> : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {tab === "games" ? <YourGames initialReplayId={initialReplayId} /> : tab === "leaderboard" ? <section className="leaderboard-section"><div className="leaderboard-head"><div><h2>Weekly leaderboard</h2><p>Best completed five-hand PnL from each player’s first three ranked starts. {bootstrap?.nextReset ? `Resets ${new Date(bootstrap.nextReset).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/Los_Angeles" })}.` : "A fresh leaderboard every week."}</p></div><div className="trade-tabs" aria-label="Leaderboard mode"><button type="button" className={`trade-tab ${boardMode === "practice" ? "active" : ""}`} aria-pressed={boardMode === "practice"} onClick={() => setBoardMode("practice")}>Practice</button><button type="button" className={`trade-tab ${boardMode === "live" ? "active" : ""}`} aria-pressed={boardMode === "live"} onClick={() => setBoardMode("live")}>Live models</button></div></div>{leaderboard.length ? <table className="leaderboard-table"><thead><tr><th scope="col">Rank</th><th scope="col">Trader</th><th scope="col" className="hide-mobile">Completed runs</th><th scope="col">Best PnL</th></tr></thead><tbody>{leaderboard.map(entry => <tr key={entry.username}><td>{entry.rank <= 3 ? <span className="rank-medal">{entry.rank}</span> : entry.rank}</td><td>{entry.username}{entry.isYou ? <span className="you-label">You</span> : null}</td><td className="hide-mobile">{entry.completedRuns}</td><td className={entry.pnl < 0 ? "negative" : "positive"}>{signed(entry.pnl)}</td></tr>)}</tbody></table> : <div className="leaderboard-empty">No scores yet.<p>No completed ranked {boardMode} challenges yet.</p></div>}<div className="table-controls"><p className="muted" style={{ fontSize: 10 }}>Ranked challenges require a profile. Practice and live results stay separate.</p><button type="button" className="primary-button" onClick={() => setTab("table")}>Back to the table <ArrowRight size={13} /></button></div></section> : <>
        <section className="stats-strip" aria-label="Challenge account"><div className="stat-block"><span className="stat-label">Available credits</span><div className="stat-value">{credits(session?.market.availableCash ?? 1000)}</div></div><div className="stat-block"><span className="stat-label">Account value</span><div className="stat-value">{credits(session?.market.totalLiquidationValue ?? 1000)}</div></div><div className="stat-block"><span className="stat-label">Total PnL</span><div className={`stat-value ${pnl < 0 ? "negative" : "positive"}`}>{signed(pnl)}</div></div><div className="stat-block"><span className="stat-label">Your challenge</span><div className="hand-progress-top"><span>{session ? `Hand ${session.hand} of 5` : "Five hands"}</span><span>{session ? session.ranked ? "Ranked" : "Unranked" : "Not started"}</span></div></div></section>
        {confirmEnd ? <section className="end-run-panel" aria-label="Confirm ending this run"><div><strong>End this challenge?</strong><p>Your unfinished score won’t enter the leaderboard.{session?.ranked ? " This ranked attempt will still count." : " You can start fresh in either mode."}</p></div><div><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmEnd(false)}>Keep playing</button><button type="button" className="primary-button" disabled={busy} onClick={() => void endRun()}>End run</button></div></section> : null}

        <a className="mobile-market-jump" href="#prediction-market">{!session ? "Set up your challenge" : session.status !== "playing" ? "View this hand’s result" : "Trade this hand"}</a><div className="game-layout"><div className="game-main"><div className="section-title"><h2 className="title-with-icon">Table <span className="muted">/</span> <span>{session ? session.mode === "live" ? "Live models" : "Practice" : "Four players"}</span></h2>{session ? <div className="table-section-actions"><span className="numeric">{session.street === "complete" ? "Showdown" : session.street.charAt(0).toUpperCase() + session.street.slice(1)}</span>{!isComplete ? <button type="button" onClick={() => { void changePlayback(true); setConfirmEnd(true); }} disabled={busy}>End run</button> : null}</div> : <span>01 — 05</span>}</div>
          {session ? <PositionsStrip session={session} /> : null}
          <PokerTable seats={seats} board={session?.board ?? []} pot={session?.pot ?? 0} winningCards={session?.winningCards ?? []} street={session?.street ?? "preflop"} started={Boolean(session)} busy={thinking} settled={Boolean(session && session.status !== "playing")} />
          {session ? <div className="table-controls"><div className="event-summary-wrap"><div className="event-summary"><strong>{loading ? "Connecting to the table…" : !session ? "Ready to deal." : isComplete ? "Five hands complete." : isHandComplete ? session.results.at(-1)?.description ?? "This hand has settled." : latestPokerAction?.text ?? "Cards dealt. Trading is open."}</strong><p>{!session ? "Start a challenge to deal the first hand." : isComplete ? "Final score settled." : isHandComplete ? `Hand PnL: ${signed(session.results.at(-1)?.pnl ?? 0)} credits · Orders closed.` : !autoPlay ? pauseUnconfirmed ? "Pause not confirmed. Retry to freeze the market." : "Paused · Trading disabled" : session.tradingOpen ? "" : "Trading reopens after the next action."}</p></div></div>{session && !isComplete ? <div className="playback-controls" aria-label="Playback controls"><div className="playback-options"><button type="button" className={`secondary-button playback-toggle ${autoPlay ? "is-playing" : ""}`} aria-pressed={autoPlay} onClick={() => void changePlayback(pauseUnconfirmed || autoPlay)} disabled={playbackChanging || confirmEnd}>{autoPlay ? <Pause size={13} /> : <Play size={13} />}{pauseUnconfirmed ? "Retry pause" : autoPlay ? "Pause" : "Play"}</button><label className="speed-picker"><span className="sr-only">Playback speed</span><select aria-label="Playback speed" value={pace} onChange={e => { const nextPace = Number(e.target.value) as PlayPace; setPace(nextPace); setCountdown(playbackDelay(nextPace, Boolean(isHandComplete))); }}><option value={6}>Normal · 6s</option><option value={3}>Fast · 3s</option><option value={0}>Realtime · no delay</option></select><ChevronDown className="speed-picker-arrow" size={13} aria-hidden="true" /></label><span className="playback-state" aria-live="off">{playbackChanging ? "Updating playback…" : pauseUnconfirmed ? "Pause not confirmed" : thinking ? `${session.players.find(p => p.seat === session.actor)?.name ?? "Model"} deciding…` : autoPlay ? pace === 0 ? "Realtime · no added delay" : `${isHandComplete ? "Next hand" : "Next action"} in ${countdown}s` : "Paused"}</span></div></div> : <div className="playback-controls"><button type="button" className="text-button" onClick={showRules}>How to play</button></div>}</div> : null}
        {isComplete ? <section className="settlement-panel"><span className="eyebrow">Final result</span><h2>Five hands complete</h2><div className={`settlement-value ${pnl < 0 ? "negative" : "positive"}`}>{signed(pnl)} <small>credits</small></div><p>{session?.ranked && session.rankEligible ? "Your completed score is on this week’s leaderboard." : "Unranked challenge complete. Sign in and enter a ranked challenge to join the weekly standings."}</p><div className="result-rows">{session?.results.map(result => <div className="result-hand" key={result.hand}><small>HAND {result.hand}</small><span className={result.pnl < 0 ? "negative" : "positive"}>{signed(result.pnl)}</span></div>)}</div><button type="button" className="secondary-button" disabled={!session?.replayAvailable} onClick={() => { setInitialReplayId(session?.id ?? null); setTab("games"); }}>Replay game</button><button type="button" className="primary-button" style={{ marginTop: 19 }} onClick={newChallenge}>Play another challenge <ArrowRight size={13} /></button></section> : null}
          {session ? <><MarketAnalytics session={session} /><div className="lower-layout"><section className="small-panel"><div className="section-title"><h2>Open orders</h2><span>{session.market.openOrders.length}</span></div>{session.market.openOrders.length ? session.market.openOrders.map(order => <div className="order-row" key={order.id}><span>{order.side === "buy" ? "Buy" : "Sell"} {order.remainingQuantity} {session.players.find(p => p.seat === order.outcome)?.name} at {price(order.limitPrice)}</span><button type="button" className="cancel-button" aria-label={`Cancel order to ${order.side} ${order.remainingQuantity} shares`} disabled={tradingBusy || !autoPlay || session.paused || playbackChanging} onClick={() => void runCommand({ type: "cancel", hand: session.hand, pokerRevision: session.pokerRevision, orderId: order.id })}>Cancel</button></div>) : <div className="empty-state">No open orders.</div>}</section><section className="small-panel"><div className="section-title"><h2>Table activity</h2><span>{session ? `Hand ${session.hand}` : "Recent actions"}</span></div>{session?.activity.length ? <div className="activity-list">{session.activity.slice(-10).reverse().map((activity, i) => <div className="activity-row" key={activity.id}><span className="activity-index">{String(session.activity.length - i).padStart(2, "0")}</span><div>{activity.text}<small>{activity.kind === "trade" ? "Your trade" : activity.kind === "system" ? "Table update" : `Hand ${activity.hand}`}</small></div></div>)}</div> : <div className="empty-state">No activity yet.<p>Poker actions and trades appear here.</p></div>}</section></div><TraderActivity session={session} /></> : null}
        </div><div className="market-column"><MarketPanel session={session} bootstrap={bootstrap} busy={loading || (!session ? busy : tradingBusy)} playing={autoPlay && !session?.paused && !playbackChanging} onCommand={runCommand} onStart={startGame} /></div></div>

      </>}
      {rules}
    </main><footer className="bottom-band"><p>Play-money only. No deposits, withdrawals, or prizes.</p></footer>
  </div>;
}
