"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, History, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import type { GameHistory, GameReplay } from "../../app/types";
import { PokerTable, type TableSeat } from "./PokerTable";
import { dollars, MarketPanel, price, signed } from "./MarketPanel";
import { MarketAnalytics, OrderBook } from "./MarketAnalytics";
import { PositionsStrip } from "./PositionsStrip";
import { TraderActivity } from "./TraderActivity";
import "./game-history.css";

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : "Could not load your games.");
  return data as T;
}

export function YourGames({ initialReplayId }: { initialReplayId: string | null }) {
  const [history, setHistory] = useState<GameHistory | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<GameReplay | null>(null);
  const [opening, setOpening] = useState<string | null>(initialReplayId);
  const [retry, setRetry] = useState(0);
  const replayRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    read<GameHistory>(`/api/games?page=${page}`, controller.signal)
      .then(setHistory).catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load your games.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, retry]);

  const openReplay = useCallback(async (id: string) => {
    replayRequest.current?.abort();
    const controller = new AbortController();
    replayRequest.current = controller;
    setOpening(id); setError(null);
    try { setReplay(await read<GameReplay>(`/api/session/${id}/replay`, controller.signal)); }
    catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load this replay.");
    } finally { if (!controller.signal.aborted) setOpening(null); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (initialReplayId) void Promise.resolve().then(() => { if (!cancelled) return openReplay(initialReplayId); });
    return () => { cancelled = true; replayRequest.current?.abort(); };
  }, [initialReplayId, openReplay]);

  function changePage(next: number) { setLoading(true); setError(null); setPage(next); }

  if (replay) return <ReplayPlayer key={replay.id} replay={replay} onClose={() => setReplay(null)} />;
  return <section className="leaderboard-section" aria-label="Your completed games">
    <div className="leaderboard-head"><div><h2>Your Games</h2><p>Watch your completed challenges again, from the opening deal to the final result.</p></div><History size={22} className="muted" /></div>
    {error ? <div className="error-banner" role="alert">{error}<button className="text-button" type="button" onClick={() => { setError(null); setLoading(true); setRetry(value => value + 1); }}>Retry</button></div> : null}
    {loading ? <div className="history-loading" role="status"><LoaderCircle size={16} className="loading-spinner" />Loading your games…</div>
      : history?.games.length ? <><div className="history-scroll"><table className="leaderboard-table history-table"><thead><tr><th scope="col">Completed</th><th scope="col">Challenge</th><th scope="col">Final PnL</th><th scope="col"><span className="sr-only">Replay</span></th></tr></thead><tbody>{history.games.map(game => <tr key={game.id}>
        <td><time dateTime={game.completedAt}>{new Date(game.completedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</time></td>
        <td>{game.mode === "live" ? "Live models" : "Practice"}<small>{game.ranked ? "Ranked" : "Unranked"} · 5 hands</small></td>
        <td className={game.pnl < 0 ? "negative" : "positive"}>{signed(game.pnl)}</td>
        <td><button type="button" className="secondary-button" disabled={!game.replayAvailable || opening !== null} title={game.replayAvailable ? "Open this recorded game" : "This game started before replay recording was available."} onClick={() => void openReplay(game.id)}>{opening === game.id ? <LoaderCircle size={12} className="loading-spinner" /> : <Play size={12} />}{opening === game.id ? "Loading…" : game.replayAvailable ? "Replay" : "Unavailable"}</button></td>
      </tr>)}</tbody></table></div><p className="history-note">Replays are recorded for new challenges. Games started before recording was added have no replay.</p></>
      : !error ? <div className="leaderboard-empty"><History size={24} className="history-empty-icon" />No completed games yet.<p>Finish all five hands and your challenge will appear here.</p></div> : null}
    {history && (page > 0 || history.nextPage !== null) ? <div className="history-pagination"><button className="secondary-button" type="button" disabled={loading || page === 0} onClick={() => changePage(page - 1)}><ArrowLeft size={12} />Newer games</button><span>Page {page + 1}</span><button className="secondary-button" type="button" disabled={loading || history.nextPage === null} onClick={() => changePage(history.nextPage!)}>Older games<ArrowRight size={12} /></button></div> : null}
  </section>;
}

export function ReplayPlayer({ replay, onClose }: { replay: GameReplay; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bookOutcome, setBookOutcome] = useState(0);
  const [delay, setDelay] = useState(2000);
  const frames = replay.frames;
  const last = frames.length - 1;
  const frame = frames[index];
  const session = frame.session;
  const finished = index === last;

  useEffect(() => {
    if (!playing || index >= last) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") { setPlaying(false); return; }
      setIndex(index + 1);
      if (index + 1 === last) setPlaying(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, delay]);

  useEffect(() => {
    const pause = () => { if (document.visibilityState !== "visible") setPlaying(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  function seek(next: number) { setPlaying(false); setIndex(Math.max(0, Math.min(last, next))); }
  function togglePlayback() {
    if (finished) { setIndex(0); setPlaying(true); }
    else setPlaying(value => !value);
  }
  const seats: TableSeat[] = session.players.map(player => ({
    id: String(player.seat), name: player.name, cards: player.cards, stack: player.stack,
    action: player.allIn ? "All-in" : player.lastAction || "Waiting", folded: player.folded,
    active: session.actor === player.seat && session.status === "playing", dealer: player.seat === session.button,
    winner: session.winners.includes(player.seat), allIn: player.allIn,
    classId: player.classId, className: player.className, description: player.description,
  }));
  const hands = [...new Set(frames.map(frame => frame.session.hand))];

  return <section className="replay-view" aria-label="Game replay">
    <div className="replay-heading"><div><span className="eyebrow"><History size={12} /> GAME REPLAY</span><h2>{session.mode === "live" ? "Live models" : "Practice"} challenge</h2><p>Recorded play · {session.ranked ? "Ranked" : "Unranked"} · Trading is disabled</p></div><button type="button" className="secondary-button" onClick={onClose}><ArrowLeft size={12} />Your Games</button></div>
    <div className="replay-controls" aria-label="Replay controls">
      <div className="replay-buttons"><button className="primary-button" type="button" onClick={togglePlayback} aria-pressed={playing}>{finished ? <RotateCcw size={13} /> : playing ? <Pause size={13} /> : <Play size={13} />}{finished ? "Replay again" : playing ? "Pause replay" : "Play replay"}</button><button className="secondary-button" type="button" disabled={index === 0} onClick={() => seek(index - 1)}><ArrowLeft size={12} />Previous</button><button className="secondary-button" type="button" disabled={finished} onClick={() => seek(index + 1)}>Next<ArrowRight size={12} /></button></div>
      <div className="replay-options"><label>Hand<select aria-label="Replay hand" value={session.hand} onChange={event => seek(frames.findIndex(frame => frame.session.hand === Number(event.target.value)))}>{hands.map(hand => <option value={hand} key={hand}>Hand {hand}</option>)}</select></label><label>Speed<select aria-label="Replay speed" value={delay} onChange={event => setDelay(Number(event.target.value))}><option value={2000}>Normal · 2s</option><option value={1000}>Fast · 1s</option><option value={4000}>Slow · 4s</option></select></label></div>
      <label className="replay-timeline"><span>{finished ? "Replay complete" : playing ? "Playing" : "Paused"} · Step {index + 1} of {frames.length}</span><input aria-label="Replay timeline" type="range" min={0} max={last} value={index} onChange={event => seek(Number(event.target.value))} /></label>
    </div>
    <section className="stats-strip" aria-label="Recorded challenge account"><div className="stat-block"><span className="stat-label">Available cash</span><div className="stat-value">{dollars(session.market.availableCash)}</div></div><div className="stat-block"><span className="stat-label">Account value</span><div className="stat-value">{dollars(session.market.totalLiquidationValue)}</div></div><div className="stat-block"><span className="stat-label">Total PnL</span><div className={`stat-value ${session.pnl < 0 ? "negative" : "positive"}`}>{signed(session.pnl)}</div></div><div className="stat-block"><span className="stat-label">Recorded hand</span><div className="hand-progress-top"><span>Hand {session.hand} of 5</span><span>{session.street === "complete" ? "Settled" : session.street}</span></div></div></section>
    <div className="game-layout"><div className="game-main"><div className="section-title"><h2>The recorded table</h2><span>Hand {session.hand} · {session.street === "complete" ? "Showdown" : session.street}</span></div>
      <PositionsStrip session={session} readOnly />
      <PokerTable seats={seats} board={session.board} pot={session.pot} winningCards={session.winningCards} street={session.street} started busy={false} settled={session.status !== "playing"} />
      <div className="table-controls"><div className="event-summary" aria-live={playing ? "off" : "polite"}><strong>{frame.label}</strong><p>Step {index + 1} of {frames.length} · <time dateTime={frame.at}>{new Date(frame.at).toLocaleTimeString("en-US")}</time></p></div></div>
      <section className="replay-order-book" aria-label="Historical order book">
        <div className="replay-book-toolbar"><div className="trade-tabs replay-book-models" role="group" aria-label="Historical order book model">{session.players.map(player => <button type="button" className={`trade-tab ${bookOutcome === player.seat ? "active" : ""}`} key={player.seat} aria-pressed={bookOutcome === player.seat} onClick={() => { setPlaying(false); setBookOutcome(player.seat); }}>{player.name}</button>)}</div><div className="replay-book-steps"><button className="text-button" type="button" aria-label="Previous recorded snapshot" disabled={index === 0} onClick={() => seek(index - 1)}>Previous</button><span>Step {index + 1} of {frames.length}</span><button className="text-button" type="button" aria-label="Next recorded snapshot" disabled={finished} onClick={() => seek(index + 1)}>Next</button></div></div>
        <OrderBook book={session.market.books.find(book => book.outcome === bookOutcome)} name={session.players.find(player => player.seat === bookOutcome)?.name} settled={session.market.status === "settled"} recordedAt={{ hand: session.hand, tick: session.market.tick }} />
        <p className="history-note">Pause, step, or scrub the replay to inspect recorded depth. Earlier replays may omit updates between recorded steps.</p>
      </section>
      <MarketAnalytics session={session} />
      <div className="lower-layout"><section className="small-panel"><div className="section-title"><h2>Recorded open orders</h2><span>{session.market.openOrders.length}</span></div>{session.market.openOrders.length ? session.market.openOrders.map(order => <div className="order-row" key={order.id}>{order.side === "buy" ? "Buy" : "Sell"} {order.remainingQuantity} {session.players.find(player => player.seat === order.outcome)?.name} at {price(order.limitPrice)}</div>) : <div className="empty-state">No open orders at this step.</div>}</section>
        <section className="small-panel"><div className="section-title"><h2>Recorded activity</h2><span>Hand {session.hand}</span></div><div className="activity-list">{session.activity.slice(-10).reverse().map(activity => <div className="activity-row" key={activity.id}><div>{activity.text}<small>{activity.kind === "trade" ? "Your trade" : `Hand ${activity.hand}`}</small></div></div>)}</div></section></div>
      <TraderActivity session={session} />
    </div><div className="market-column"><MarketPanel session={session} bootstrap={null} busy={false} readOnly showOrderBook={false} selectedOutcome={bookOutcome} onSelectOutcome={outcome => { setPlaying(false); setBookOutcome(outcome); }} /></div></div>
    {session.status === "complete" ? <section className="settlement-panel"><span className="eyebrow">FINAL RESULT</span><h2>Five hands complete</h2><div className={`settlement-value ${session.pnl < 0 ? "negative" : "positive"}`}>{signed(session.pnl)}</div><div className="result-rows">{session.results.map(result => <div className="result-hand" key={result.hand}><small>HAND {result.hand}</small><span className={result.pnl < 0 ? "negative" : "positive"}>{signed(result.pnl)}</span></div>)}</div></section> : null}
  </section>;
}
