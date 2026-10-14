"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowRight, Check, ChevronRight, CircleHelp, CirclePause, Clock3, Info, LoaderCircle, LogIn, RotateCcw, ShieldCheck, Trophy, UserRound, X } from "lucide-react";
import type { Bootstrap, GameMode, Profile, SessionCommand, SessionView } from "./types";
import { MODEL_SEATS, PokerTable, type TableSeat } from "../components/river/PokerTable";
import { credits, MarketPanel, price, signed } from "../components/river/MarketPanel";

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
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [tab, setTab] = useState<"table" | "leaderboard">("table");
  const [profileOpen, setProfileOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [boardMode, setBoardMode] = useState<GameMode>("practice");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const sessionRef = useRef<SessionView | null>(null);
  const commandQueue = useRef<Promise<void>>(Promise.resolve());
  const commandCount = useRef(0);
  const mounted = useRef(true);

  const acceptSession = useCallback((next: SessionView) => {
    const previous = sessionRef.current;
    if (previous?.id === next.id && previous.version > next.version) return;
    sessionRef.current = next;
    if (mounted.current) setSession(next);
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
        const resumed = await request<SessionView>(`/api/session/${data.activeSessionId}`);
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
    if (background && commandCount.current > 0) return;
    commandCount.current++;
    if (!background) { setBusy(true); setError(null); }
    if (command.type === "advance") setAdvancing(true);
    const action = commandQueue.current.catch(() => {}).then(async () => {
      try {
        const next = await request<SessionView>(`/api/session/${current.id}/command`, { method: "POST", body: JSON.stringify({ ...command, requestId: crypto.randomUUID() }) });
        if (sessionRef.current?.id !== current.id) return;
        acceptSession(next);
        if (!background) {
          const latest = next.activity.at(-1);
          setAnnouncement(command.type === "order" ? latest?.text ?? "Order submitted. Check your positions and open orders." : command.type === "cancel" ? "Order cancelled." : latest?.text ?? "The table has advanced.");
        }
        if (next.status === "complete" && current.status !== "complete") void loadBootstrap().catch(() => {});
      } catch (e) {
        if (!background && mounted.current) setError(e instanceof Error ? e.message : "That action did not complete.");
      } finally {
        commandCount.current--;
        if (!background && mounted.current) setBusy(false);
        if (command.type === "advance" && mounted.current) setAdvancing(false);
      }
    });
    commandQueue.current = action;
    await action;
  }, [acceptSession, loadBootstrap]);

  const activeId = session?.id;
  const isPlaying = session?.status === "playing";
  useEffect(() => {
    if (!activeId || !isPlaying) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void runCommand({ type: "tick" });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeId, isPlaying, runCommand]);

  async function startGame(mode: GameMode, ranked: boolean) {
    setBusy(true); setError(null);
    try {
      await commandQueue.current;
      const next = await request<SessionView>("/api/session", { method: "POST", body: JSON.stringify({ mode, ranked, requestId: crypto.randomUUID() }) });
      acceptSession(next); setTab("table"); setAnnouncement("Challenge started. The first hand is dealt and trading is open.");
      void loadBootstrap().catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start your challenge."); }
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
    setBusy(true); setError(null);
    try {
      await commandQueue.current;
      await request<{ ok: true }>(`/api/session/${session.id}`, { method: "DELETE", body: "{}" });
      sessionRef.current = null; setSession(null); setConfirmEnd(false);
      setAnnouncement("Run ended. You can start a new challenge.");
      await loadBootstrap();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not end this run."); }
    finally { setBusy(false); }
  }

  function newChallenge() { sessionRef.current = null; setSession(null); setAnnouncement(""); setTab("table"); }
  function showRules() { setRulesOpen(true); window.setTimeout(() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 0); }

  const seats: TableSeat[] = session ? session.players.map(p => ({ id: String(p.seat), name: p.name, cards: p.cards, stack: p.stack, action: p.allIn ? "All-in" : p.lastAction || "Waiting", folded: p.folded, active: session.actor === p.seat && session.status === "playing", dealer: p.seat === session.button, winner: session.winners.includes(p.seat), description: p.description })) : bootstrap?.models?.length ? bootstrap.models.map(m => ({ ...MODEL_SEATS[m.seat], id: String(m.seat), name: m.name, description: m.description })) : MODEL_SEATS;
  const latestPokerAction = session?.activity.filter(a => a.kind === "poker" && a.hand === session.hand).at(-1);
  const isComplete = session?.status === "complete";
  const thinking = advancing || Boolean(session?.busy);
  const isHandComplete = session?.status === "hand_complete";
  const positions = session?.market.positions.filter(p => p.quantity > 0) ?? [];
  const leaderboard = boardMode === "live" ? bootstrap?.leaderboard ?? [] : bootstrap?.practiceLeaderboard ?? [];
  const pnl = session?.pnl ?? 0;
  const rules = <details className="rules-details" id="how-it-works" open={rulesOpen} onToggle={e => setRulesOpen(e.currentTarget.open)}><summary>How River Market works</summary><div className="rules-content"><p><strong>The challenge:</strong> begin with 1,000 play-money credits and trade across five poker hands. You are a spectator and a trader; the four models are the poker players. Each new hand starts a new outcome market, and your credits carry forward.</p><p><strong>Your information:</strong> every dealt hole card is visible to you. The models only receive their own cards and the public table. Future community cards stay hidden until dealt. Player descriptions describe tendencies; a model can still bluff, fold, or surprise you.</p><p><strong>The market:</strong> synthetic traders place funded bids and asks. You can buy available shares at the shown ask, sell shares you own at the shown bid, or place a limit order. Orders can fill partly, and prices can change. Each observed poker action opens a 45-second trading window. Advance when ready, or continue after the timer ends. Unfilled immediate orders cancel; resting limit orders can carry across actions until filled, cancelled, or the hand settles.</p><p><strong>Settlement:</strong> a share in the sole main-pot winner pays 1 credit. If the main pot is tied, the winners split that credit equally. All other shares pay zero. Side-pot winners do not determine the contract. Outstanding orders cancel when the hand settles.</p><p><strong>Scoring:</strong> final PnL is your credits after five hands minus the starting 1,000. During play, account value uses available bids, so shares without buyers are conservatively marked at zero. Practice and live models have separate weekly leaderboards. Your best completed score from your first three ranked starts each week counts. Practice and live share that three-start allowance. An unfinished or abandoned ranked start still uses an attempt. Ranked challenges require sign-in and a username.</p><p><strong>Practice versus live:</strong> practice uses local decision models with distinct playing styles. Live mode calls the actual GPT, Claude, Gemini, and Grok providers when connected. This is a play-money game, with no deposits, withdrawals, or prizes.</p></div></details>;

  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to game</a>
    <header className="site-header"><Link className="brand" href="/" aria-label="River Market home"><span className="brand-symbol" aria-hidden="true">♠</span>River Market<span className="brand-dot">.</span></Link><nav className="header-nav" aria-label="Main navigation"><button className={`nav-link ${tab === "table" ? "active" : ""}`} type="button" onClick={() => setTab("table")}>The table</button><button className={`nav-link ${tab === "leaderboard" ? "active" : ""}`} type="button" onClick={() => setTab("leaderboard")}>Leaderboard</button></nav>{bootstrap?.authenticated ? <button className="user-button" type="button" onClick={() => setProfileOpen(!profileOpen)} aria-expanded={profileOpen} aria-label="Open your profile"><span className="avatar-dot">{(bootstrap.profile?.username ?? "You").slice(0, 1).toUpperCase()}</span>{bootstrap.profile?.username ?? "Your profile"}<ChevronRight size={11} /></button> : <a className="user-button" href="/signin-with-chatgpt?return_to=/" target="_top" aria-label="Sign in with ChatGPT"><span className="avatar-dot"><UserRound size={11} /></span>Sign in<LogIn size={11} /></a>}</header>
    <main id="main">
      <div className="masthead"><div><span className="eyebrow"><span className="tiny-diamond">◇</span> POKER MEETS PREDICTION</span><h1>Read the table. Trade the outcome.</h1><p>Four AI players. Every hand in plain sight. Find your edge in the space between the cards and the odds.</p></div><div className="masthead-right"><span className="mode-badge"><ShieldCheck size={11} /> Play-money only</span><button className="text-button" type="button" onClick={showRules}>How to play <CircleHelp size={13} /></button></div></div>
      {error ? <div className="error-banner" role="alert"><Info size={15} /><span>{error}{!bootstrap && !loading ? <button type="button" className="text-button" onClick={() => { setLoading(true); setError(null); void initialize(); }}>Retry connection <RotateCcw size={11} /></button> : null}</span><button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button></div> : null}
      {session?.notice ? <div className="notice-banner"><Info size={14} /><span>{session.notice}</span></div> : null}
      {profileOpen ? <section className="settings-panel" aria-label="Your profile"><h2>Make a name for yourself.</h2><p>Your public username appears on the weekly leaderboard. Three ranked starts per week are shared across both modes. {bootstrap?.profile ? `${bootstrap.profile.remainingAttempts} ranked attempts remaining this week.` : "Set one to enter ranked challenges."}</p><form onSubmit={saveProfile} className="profile-form"><div><label htmlFor="username">Public username</label><input className="text-input" id="username" autoComplete="nickname" minLength={3} maxLength={20} required value={username} onChange={e => setUsername(e.target.value)} placeholder="Your table name" /></div><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={12} className="loading-spinner" /> : <Check size={12} />}Save username</button></form></section> : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {tab === "leaderboard" ? <section className="leaderboard-section"><div className="leaderboard-head"><div><span className="eyebrow">THE WEEKLY STANDINGS</span><h2>A good read goes a long way.</h2><p>Best completed five-hand PnL from each player’s first three ranked starts. {bootstrap?.nextReset ? `Resets ${new Date(bootstrap.nextReset).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/Los_Angeles" })}.` : "A fresh leaderboard every week."}</p></div><div className="trade-tabs" aria-label="Leaderboard mode"><button type="button" className={`trade-tab ${boardMode === "practice" ? "active" : ""}`} aria-pressed={boardMode === "practice"} onClick={() => setBoardMode("practice")}>Practice</button><button type="button" className={`trade-tab ${boardMode === "live" ? "active" : ""}`} aria-pressed={boardMode === "live"} onClick={() => setBoardMode("live")}>Live models</button></div></div>{leaderboard.length ? <table className="leaderboard-table"><thead><tr><th scope="col">Rank</th><th scope="col">Trader</th><th scope="col" className="hide-mobile">Completed runs</th><th scope="col">Best PnL</th></tr></thead><tbody>{leaderboard.map(entry => <tr key={entry.username}><td>{entry.rank <= 3 ? <span className="rank-medal">{entry.rank}</span> : entry.rank}</td><td>{entry.username}{entry.isYou ? <span className="you-label">You</span> : null}</td><td className="hide-mobile">{entry.completedRuns}</td><td className={entry.pnl < 0 ? "negative" : "positive"}>{signed(entry.pnl)}</td></tr>)}</tbody></table> : <div className="leaderboard-empty"><Trophy size={24} style={{ margin: "0 auto 13px", color: "#8a987a" }} />A new week. An open table.<p>No completed ranked {boardMode} challenges yet. Your name could be first.</p></div>}<div className="table-controls"><p className="muted" style={{ fontSize: 10 }}>Ranked challenges require a profile. Practice and live results stay separate.</p><button type="button" className="primary-button" onClick={() => setTab("table")}>Back to the table <ArrowRight size={13} /></button></div></section> : <>
        <section className="stats-strip" aria-label="Challenge account"><div className="stat-block"><span className="stat-label">Available credits</span><div className="stat-value">{credits(session?.market.availableCash ?? 1000)}<small>CR</small></div></div><div className="stat-block"><span className="stat-label">Account value</span><div className="stat-value">{credits(session?.market.totalLiquidationValue ?? 1000)}<small>CR</small></div></div><div className="stat-block"><span className="stat-label">Total PnL</span><div className={`stat-value ${pnl < 0 ? "negative" : "positive"}`}>{signed(pnl)}<small>CR</small></div></div><div className="stat-block"><span className="stat-label">Your challenge</span><div className="hand-progress-top"><span>{session ? `Hand ${session.hand} of 5` : "Five hands to find your edge"}</span><span>{session ? session.ranked ? "Ranked" : "Unranked" : "Ready when you are"}</span></div><div className="hand-steps" aria-hidden="true">{[1, 2, 3, 4, 5].map(hand => <span className={`hand-step ${session && (session.hand > hand || session.status !== "playing" && session.hand === hand) ? "done" : session?.hand === hand ? "current" : ""}`} key={hand} />)}</div></div></section>
        {confirmEnd ? <section className="end-run-panel" aria-label="Confirm ending this run"><div><strong>End this challenge?</strong><p>Your unfinished score won’t enter the leaderboard.{session?.ranked ? " This ranked attempt will still count." : " You can start fresh in either mode."}</p></div><div><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmEnd(false)}>Keep playing</button><button type="button" className="primary-button" disabled={busy} onClick={() => void endRun()}>End run</button></div></section> : null}
        {isComplete ? <section className="settlement-panel"><span className="eyebrow"><Trophy size={12} /> FIVE HANDS. YOUR FINAL RESULT.</span><h2>{pnl > 0 ? "You found your edge." : pnl === 0 ? "A level finish." : "Every table teaches you something."}</h2><div className={`settlement-value ${pnl < 0 ? "negative" : "positive"}`}>{signed(pnl)} <small style={{ fontSize: 12, color: "#829174" }}>credits</small></div><p>{session?.ranked && session.rankEligible ? "Your completed score is on this week’s leaderboard." : "Unranked challenge complete. Sign in and enter a ranked challenge to join the weekly standings."}</p><div className="result-rows">{session?.results.map(result => <div className="result-hand" key={result.hand}><small>HAND {result.hand}</small><span className={result.pnl < 0 ? "negative" : "positive"}>{signed(result.pnl)}</span></div>)}</div><button type="button" className="primary-button" style={{ marginTop: 19 }} onClick={newChallenge}>Play another challenge <ArrowRight size={13} /></button></section> : null}
        <a className="mobile-market-jump" href="#prediction-market">{!session ? "Set up your challenge" : session.status !== "playing" ? "View this hand’s result" : "Trade this hand"}<ArrowDownRight size={13} /></a><div className="game-layout"><div className="game-main"><div className="section-title"><h2 className="title-with-icon">The table <span className="muted">/</span> <span>{session ? session.mode === "live" ? "Live AI providers" : "Practice decision models" : "Four seats. No hidden hands."}</span></h2>{session ? <div className="table-section-actions"><span className="numeric">{session.street === "complete" ? "Showdown" : session.street.charAt(0).toUpperCase() + session.street.slice(1)}</span>{!isComplete ? <button type="button" onClick={() => setConfirmEnd(true)} disabled={busy}>End run</button> : null}</div> : <span>01 — 05</span>}</div>
          <PokerTable seats={seats} board={session?.board ?? []} pot={session?.pot ?? 0} winningCards={session?.winningCards ?? []} street={session?.street ?? "preflop"} started={Boolean(session)} busy={thinking} settled={Boolean(session && session.status !== "playing")} />
          <div className="table-controls"><div className="event-summary-wrap"><span className="event-icon">{isHandComplete || isComplete ? <Check size={14} /> : <CirclePause size={14} />}</span><div className="event-summary"><strong>{loading ? "Connecting to the table…" : !session ? "The table is yours to read." : isComplete ? "Five hands complete." : isHandComplete ? session.results.at(-1)?.description ?? "This hand has settled." : latestPokerAction?.text ?? "The cards are dealt. Find your first trade."}</strong><p>{!session ? "Start a challenge to deal the first hand." : isComplete ? "Review your trades, or take another seat at the market." : isHandComplete ? `Hand PnL: ${signed(session.results.at(-1)?.pnl ?? 0)} credits. Outstanding orders are closed.` : session.tradingOpen ? "Trade now, then continue when you’re ready." : "The trading window ended. Continue to the next action."}</p></div></div>{session && !isComplete ? <button type="button" className="primary-button" disabled={busy || session.busy} onClick={() => void runCommand({ type: isHandComplete ? "next_hand" : "advance", pokerRevision: session.pokerRevision })}>{thinking ? <LoaderCircle size={13} className="loading-spinner" /> : null}{thinking ? "Thinking…" : isHandComplete ? `Deal hand ${session.hand + 1}` : "Next action"}{!thinking ? <ArrowRight size={13} /> : null}</button> : <button type="button" className="text-button" onClick={showRules}>The rules <ArrowDownRight size={13} /></button>}</div>
          <details className="player-styles"><summary>Read the players <span>Playing style descriptions</span><ChevronRight size={12} /></summary><div className="style-grid">{seats.map(seat => <div key={seat.id}><strong>{seat.name}</strong><p>{seat.description}</p></div>)}</div></details><div className="lower-layout"><section className="small-panel"><div className="section-title"><h2>Your positions</h2><span>{positions.length} open</span></div>{positions.length ? positions.map(position => <div className="position-row" key={position.outcome}><div><strong>{session?.players.find(p => p.seat === position.outcome)?.name}</strong><small>{position.quantity} shares · avg {price(position.averageCost)}{position.unliquidatedQuantity > 0 ? ` · ${position.unliquidatedQuantity} without bids` : ""}</small></div><div><strong className={position.unrealizedPnl < 0 ? "negative" : "positive"}>{signed(position.unrealizedPnl)}</strong><small>{credits(position.liquidationValue)} value</small></div></div>) : <div className="empty-state">Your first position starts with a good read.<p>Buy an outcome to see your shares here.</p></div>}{session?.market.openOrders.length ? <><div className="section-title" style={{ marginTop: 14 }}><h2>Open orders</h2><span>{session.market.openOrders.length}</span></div>{session.market.openOrders.map(order => <div className="order-row" key={order.id}><span>{order.side === "buy" ? "Buy" : "Sell"} {order.remainingQuantity} {session.players.find(p => p.seat === order.outcome)?.name} at {price(order.limitPrice)}</span><button type="button" className="cancel-button" aria-label={`Cancel order to ${order.side} ${order.remainingQuantity} shares`} disabled={busy} onClick={() => void runCommand({ type: "cancel", pokerRevision: session.pokerRevision, orderId: order.id })}>Cancel</button></div>)}</> : null}</section><section className="small-panel"><div className="section-title"><h2>Table activity</h2><span>{session ? `Hand ${session.hand}` : "The story as it unfolds"}</span></div>{session?.activity.length ? <div className="activity-list">{session.activity.slice(-10).reverse().map((activity, i) => <div className="activity-row" key={activity.id}><span className="activity-index">{String(session.activity.length - i).padStart(2, "0")}</span><div>{activity.text}<small>{activity.kind === "trade" ? "Your trade" : activity.kind === "system" ? "Table update" : `Hand ${activity.hand}`}</small></div></div>)}</div> : <div className="empty-state">Every move leaves a clue.<p>Raises, folds, and your trades appear here.</p></div>}</section></div>
        </div><MarketPanel session={session} bootstrap={bootstrap} busy={busy || loading} onCommand={runCommand} onStart={startGame} /></div>
        <div className="info-strip"><span><ShieldCheck size={11} /> Server-enforced poker rules</span><span><Clock3 size={11} /> Five hands per challenge</span><button type="button" className="rules-link" onClick={showRules}>Market & settlement rules <ChevronRight size={10} /></button></div>
      </>}
      {rules}
    </main><footer className="bottom-band"><div><span className="bottom-mini-logo">An edge, not a guarantee.</span><p>Built for the read. <strong>Play-money only.</strong> No deposits, withdrawals, or prizes.</p></div><div className="bottom-links"><button type="button" onClick={showRules}>How it works</button><button type="button" onClick={() => { setTab("leaderboard"); window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}>Weekly standings <ArrowRight size={10} style={{ display: "inline", marginLeft: 4 }} /></button></div></footer>
  </div>;
}
