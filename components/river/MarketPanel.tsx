"use client";
import { useState } from "react";
import type { Bootstrap, GameMode, SessionCommand, SessionView } from "../../app/types";
import { equityDescription, OrderBook, percent } from "./MarketAnalytics";

export function credits(value: number) { return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function signed(value: number) { return `${value < 0 ? "−" : "+"}${credits(Math.abs(value))}`; }
export function price(value: number | null | undefined) { return value == null ? "—" : `${Math.round(value * 100)}¢`; }

export function MarketPanel({ session, bootstrap, busy, playing, onCommand, onStart }: {
  session: SessionView | null; bootstrap: Bootstrap | null; busy: boolean; playing: boolean;
  onCommand: (command: SessionCommand) => Promise<void>;
  onStart: (mode: GameMode, ranked: boolean) => Promise<void>;
}) {
  const [selected, setSelected] = useState(0);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("25");
  const [orderType, setOrderType] = useState<"ioc" | "limit">("ioc");
  const [limit, setLimit] = useState("25");
  const [mode, setMode] = useState<GameMode>("practice");
  const [ranked, setRanked] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const names = session?.players ?? [];
  const book = session?.market.books.find(b => b.outcome === selected);
  const position = session?.market.positions.find(p => p.outcome === selected);
  const selectedPlayer = names.find(p => p.seat === selected);
  const selectedPrice = side === "buy" ? book?.bestAsk : book?.bestBid;
  const actualPrice = orderType === "limit" ? Number(limit) / 100 : selectedPrice;
  const total = Number(quantity) * (actualPrice ?? 0);
  const ended = Boolean(session && session.status !== "playing");
  const lastTrade = session?.activity.filter(a => a.kind === "trade" && a.hand === session.hand).at(-1);
  const paused = Boolean(session && (!playing || session.paused));
  const unavailable = paused || !session?.tradingOpen || ended;
  const noQuote = orderType === "ioc" && selectedPrice == null;
  const insufficient = side === "buy" ? total > (session?.market.availableCash ?? 0) : Number(quantity) > (position?.availableQuantity ?? 0);

  async function submitOrder() {
    setTicketError(null);
    if (unavailable || busy) return;
    if (!session || actualPrice == null || !Number.isInteger(Number(quantity)) || Number(quantity) < 1) {
      setTicketError("Enter a positive whole number of shares."); return;
    }
    if (!Number.isFinite(actualPrice) || actualPrice < .01 || actualPrice > .99 || Math.abs(actualPrice * 100 - Math.round(actualPrice * 100)) > 1e-7) {
      setTicketError("Choose a limit from 1¢ to 99¢ in whole cents."); return;
    }
    if (insufficient) { setTicketError(side === "buy" ? "Not enough available credits for this order." : "You can only sell shares you own and haven’t reserved."); return; }
    await onCommand({ type: "order", pokerRevision: session.pokerRevision, outcome: selected, side, quantity: Number(quantity), limitPrice: actualPrice, orderType });
  }

  return <aside className="market-aside" id="prediction-market" aria-label="Prediction market">
    <div className="section-title"><h2>{session ? "Who wins?" : "New challenge"}</h2>{session ? <span>{ended ? "Settled" : paused ? "Paused" : session.tradingOpen ? `${session.marketSecondsRemaining}s open` : "Closed"}</span> : null}</div>
    <section className={`market-panel ${!session ? "market-panel-intro" : ""}`}>
      {session ? <><div className="market-columns"><span>Model</span><span>{ended ? "Payout" : "Buy"}</span><span>{ended ? "Result" : "Sell"}</span></div>
      <div className="market-outcomes" aria-label="Outcome prices">{names.map(model => {
        const rowBook = session?.market.books.find(b => b.outcome === model.seat);
        const holding = session?.market.positions.find(p => p.outcome === model.seat)?.quantity ?? 0;
        const payout = session?.market.payouts?.[model.seat] ?? 0;
        const detail = holding > 0 ? `${holding} shares` : session?.players.find(p => p.seat === model.seat)?.folded ? "Folded" : ended && payout > 0 ? "Winner" : null;
        return <button type="button" key={model.seat} className={`market-row ${selected === model.seat ? "selected" : ""}`} aria-pressed={selected === model.seat} onClick={() => { setSelected(model.seat); setTicketError(null); }}>
          <span className="market-model"><span className="market-model-name">{model.name}</span>{detail ? <small className="market-row-detail">{detail}</small> : null}</span>
          <span className="price-box" aria-label={ended ? `Payout ${payout} credits` : `Buy ${price(rowBook?.bestAsk)}`}>{ended ? payout > 0 && payout < 1 ? `1/${session?.winners.length}` : price(payout) : price(rowBook?.bestAsk)}</span><span className="price-box sell-price" aria-label={ended ? payout > 0 ? "Winner" : "Lost" : `Sell ${price(rowBook?.bestBid)}`}>{ended ? payout > 0 ? "WIN" : "—" : price(rowBook?.bestBid)}</span>
        </button>;
      })}</div></> : null}
      {!session ? <div className="intro-ticket"><p>5 hands · 1,000 credits</p>
        <div className="mode-choices"><button type="button" className={`mode-choice ${mode === "practice" ? "active" : ""}`} aria-pressed={mode === "practice"} onClick={() => setMode("practice")}><strong>Practice</strong><small>Instant decisions</small></button><button type="button" className={`mode-choice ${mode === "live" ? "active" : ""}`} aria-pressed={mode === "live"} onClick={() => setMode("live")}><strong>Live models</strong><small>Four AI providers</small></button></div>
        {mode === "live" && !bootstrap?.liveAvailable ? <div className="live-unavailable">{bootstrap?.liveUnavailableReason ?? "Live providers are not connected yet. Practice is ready to play."}</div> : null}
        {bootstrap?.authenticated && bootstrap.profile ? <label className="ranked-choice"><input type="checkbox" checked={ranked} onChange={e => setRanked(e.target.checked)} /> Enter weekly leaderboard <span>{bootstrap.profile.remainingAttempts} attempts left</span></label> : null}
        {mode === "live" && bootstrap?.liveAvailable && !bootstrap.authenticated ? <a className="primary-button wide" href="/signin-with-chatgpt?return_to=/" target="_top">Sign in for live models</a> : <button type="button" className="primary-button wide" disabled={busy || !bootstrap || mode === "live" && !bootstrap.liveAvailable || ranked && !bootstrap.profile?.remainingAttempts} onClick={() => void onStart(mode, ranked)}>{busy ? "Starting…" : mode === "live" ? "Start live challenge" : "Start practice challenge"}</button>}
        {!bootstrap?.authenticated ? <p className="login-hint"><a href="/signin-with-chatgpt?return_to=/" target="_top">Sign in</a> to enter the leaderboard.</p> : !bootstrap.profile ? <p className="login-hint">Choose a username in your profile to enter ranked challenges.</p> : <p className="login-hint">{ranked ? "Ranked attempts count when a challenge starts." : "Unranked. No weekly attempt used."}</p>}

      </div> : ended ? <div className="trade-ticket settlement-ticket"><span className="eyebrow">Hand {session.hand} settled</span><h3>{session.results.at(-1)?.description ?? "This hand is complete."}</h3><div className="trade-details"><div><span>This hand’s PnL</span><strong className={(session.results.at(-1)?.pnl ?? 0) < 0 ? "negative" : "positive"}>{signed(session.results.at(-1)?.pnl ?? 0)} credits</strong></div><div><span>Your balance</span><strong>{credits(session.market.cash)} credits</strong></div></div>{session.status === "hand_complete" ? <p className="ticket-note">{paused ? "Press Play to deal the next hand." : "The next hand deals automatically."}</p> : <p className="ticket-note">Five hands complete.</p>}</div> : <div className="trade-ticket">
        <div className="ticket-top"><h3>{selectedPlayer?.name} shares</h3><div className="trade-tabs" aria-label="Trade side"><button className={`trade-tab ${side === "buy" ? "active" : ""}`} type="button" aria-pressed={side === "buy"} onClick={() => { setSide("buy"); setTicketError(null); }}>Buy</button><button className={`trade-tab ${side === "sell" ? "active" : ""}`} type="button" aria-pressed={side === "sell"} onClick={() => { setSide("sell"); setTicketError(null); }}>Sell</button></div></div>
        <label className="field-label" htmlFor="order-type">Order type <span>{orderType === "ioc" ? "Unfilled shares cancel" : "Can carry across actions"}</span></label><select className="select-input" id="order-type" value={orderType} onChange={e => setOrderType(e.target.value as "ioc" | "limit")}><option value="ioc">Buy / sell at displayed quote</option><option value="limit">Limit order</option></select>
        <label className="field-label" htmlFor="trade-quantity">Quantity <span>{side === "buy" ? `${credits(session.market.availableCash)} credits available` : `${position?.availableQuantity ?? 0} shares available`}</span></label><div className="input-with-unit"><input className="text-input" id="trade-quantity" type="number" inputMode="numeric" min="1" max="100000" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} /><span>shares</span></div><div className="quick-amounts" aria-label="Share quantity presets">{[10, 25, 50, 100].map(q => <button type="button" key={q} onClick={() => setQuantity(String(q))}>{q}</button>)}</div>
        {orderType === "limit" ? <><label className="field-label" htmlFor="limit-price">{side === "buy" ? "Maximum buy price" : "Minimum sell price"}</label><div className="input-with-unit"><input className="text-input" id="limit-price" type="number" inputMode="numeric" min="1" max="99" step="1" value={limit} onChange={e => setLimit(e.target.value)} /><span>cents</span></div></> : null}
        <div className="trade-details"><div><span>{side === "buy" ? "Price per share" : "Minimum sale price"}</span><strong>{price(actualPrice)}</strong></div><div><span title={equityDescription(session.odds)}>Showdown equity</span><strong>{percent(session.odds.equities[selected])}</strong></div><div><span>{side === "buy" ? "Maximum cost" : "Proceeds if fully filled"}</span><strong>{credits(Number.isFinite(total) ? total : 0)} credits</strong></div>{side === "buy" ? <div><span>Payout if sole winner</span><strong>{credits(Number(quantity) || 0)} credits</strong></div> : null}</div>
        {ticketError ? <p className="ticket-error" role="alert">{ticketError}</p> : null}
        <button type="button" className="primary-button wide" disabled={busy || unavailable || noQuote || insufficient || !Number(quantity)} onClick={() => void submitOrder()}>{ended ? "Hand settled" : paused ? "Press Play to trade" : unavailable ? "Trading window closed" : noQuote ? "No quote available" : insufficient ? side === "buy" ? "Not enough credits" : "Not enough shares" : busy ? "Submitting…" : `${side === "buy" ? "Buy" : "Sell"} ${Number(quantity) || 0} shares`}</button>
        <details className="ticket-rules"><summary>Contract rules</summary><p>Shares pay 1 credit to the sole main-pot winner; ties split that credit. Partial fills are possible. Showdown equity assumes no further folds.</p></details>{lastTrade ? <p className="trade-feedback">{lastTrade.text}</p> : null}
      </div>}
    </section>
    {session ? <OrderBook book={book} name={selectedPlayer?.name} settled={ended} /> : null}
  </aside>;
}
