"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { ModelMark } from "./PokerTable";
import type { Bootstrap, GameMode, SessionCommand, SessionView } from "../../app/types";
import { equityDescription, OrderBook, percent } from "./MarketAnalytics";
import { orderPreview } from "../../lib/order-preview";
import { sharesAtQuote } from "../../lib/market-display";

export function dollars(value: number) { return value.toLocaleString("en-US", { style: "currency", currency: "USD" }); }
export function signed(value: number) { return `${value < 0 ? "−" : "+"}${dollars(Math.abs(value))}`; }
export function price(value: number | null | undefined) { return value == null ? "—" : `${Math.round(value * 100)}¢`; }

export function MarketPanel({ session, bootstrap, busy, playing = false, onCommand, onStart, readOnly = false, showOrderBook = true, selectedOutcome, onSelectOutcome }: {
  session: SessionView | null; bootstrap: Bootstrap | null; busy: boolean; playing?: boolean;
  onCommand?: (command: SessionCommand) => Promise<void>;
  onStart?: (mode: GameMode, ranked: boolean, personalitiesEnabled: boolean) => Promise<boolean>;
  readOnly?: boolean; showOrderBook?: boolean; selectedOutcome?: number; onSelectOutcome?: (outcome: number) => void;
}) {
  const [localSelected, setSelected] = useState(0);
  const selected = selectedOutcome ?? localSelected;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("25");
  const [orderType, setOrderType] = useState<"ioc" | "limit">("ioc");
  const [limit, setLimit] = useState("25");
  const [mode, setMode] = useState<GameMode>("practice");
  const [ranked, setRanked] = useState(false);
  const [personalitiesEnabled, setPersonalitiesEnabled] = useState(false);
  const [quote, setQuote] = useState<{ id: string; hand: number; outcome: number; side: "buy" | "sell"; price: number | null } | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [dismissedTrade, setDismissedTrade] = useState<string | null>(null);
  const names = session?.players ?? [];
  const book = session?.market.books.find(b => b.outcome === selected);
  const position = session?.market.positions.find(p => p.outcome === selected);
  const selectedPlayer = names.find(p => p.seat === selected);
  const selectedPrice = side === "buy" ? book?.bestAsk : book?.bestBid;
  const quoteHeld = Boolean(quote && session && quote.id === session.id && quote.hand === session.hand && quote.outcome === selected && quote.side === side);
  const draftStale = Boolean(quote && session && (quote.id !== session.id || quote.hand !== session.hand));
  const quickPrice = quoteHeld ? quote!.price : selectedPrice;
  const quotedDepth = side === "buy" ? book?.asks : book?.bids;
  const withinLimit = (p: number) => quickPrice != null && (side === "buy" ? p <= quickPrice : p >= quickPrice);
  const ownQuotedShares = session?.market.openOrders.filter(order => order.outcome === selected && order.side !== side && withinLimit(order.limitPrice)).reduce((sum, order) => sum + order.remainingQuantity, 0) ?? 0;
  const availableAtQuote = Math.max(0, (quotedDepth?.filter(level => withinLimit(level.price)).reduce((sum, level) => sum + level.quantity, 0) ?? 0) - ownQuotedShares);
  const actualPrice = orderType === "limit" ? Number(limit) / 100 : quickPrice;
  const preview = orderPreview(quantity, actualPrice);
  const inputError = preview.quantityError ?? (orderType === "limit" ? preview.priceError : null);
  const invalidDraft = preview.quantity == null || preview.price == null;
  const ended = Boolean(session && session.status !== "playing");
  const lastTrade = session?.activity.filter(a => a.kind === "trade" && a.hand === session.hand).at(-1);
  const paused = Boolean(session && (!playing || session.paused));
  const unavailable = paused || !session?.tradingOpen || ended;
  const outcomeClosed = Boolean(selectedPlayer?.folded);
  const noQuote = outcomeClosed || orderType === "ioc" && actualPrice == null;
  const insufficient = !invalidDraft && (side === "buy" ? preview.total! > (session?.market.availableCash ?? 0) : preview.quantity! > (position?.availableQuantity ?? 0));

  function selectOutcome(outcome: number, tradeSide?: "buy" | "sell") {
    setSelected(outcome);
    onSelectOutcome?.(outcome);
    setTicketError(null);
    if (tradeSide && session) {
      setSide(tradeSide);
      const selectedBook = session.market.books.find(item => item.outcome === outcome);
      setQuote({ id: session.id, hand: session.hand, outcome, side: tradeSide, price: (tradeSide === "buy" ? selectedBook?.bestAsk : selectedBook?.bestBid) ?? null });
    } else {
      setQuote(null);
    }
  }

  function holdQuote(refresh = false) {
    if (!session || !refresh && (quoteHeld || draftStale)) return;
    setQuote({ id: session.id, hand: session.hand, outcome: selected, side, price: selectedPrice ?? null });
  }

  async function submitOrder() {
    setTicketError(null);
    if (readOnly || !onCommand || unavailable || outcomeClosed || busy || draftStale) return;
    if (!session || preview.quantity == null || preview.price == null) {
      setTicketError(inputError ?? "No quote available."); return;
    }
    if (insufficient) { setTicketError(side === "buy" ? "Not enough available cash for this order." : "You can only sell shares you own and haven’t reserved."); return; }
    await onCommand({ type: "order", hand: session.hand, pokerRevision: session.pokerRevision, outcome: selected, side, quantity: preview.quantity, limitPrice: preview.price, orderType });
  }

  return <aside className="market-aside" id="prediction-market" aria-label="Prediction market">
    <div className="section-title"><h2>{session ? "Who wins?" : "New challenge"}</h2>{session ? <span>{readOnly ? "Replay" : ended ? "Settled" : paused ? "Paused" : session.tradingOpen ? "Open" : "Closed"}</span> : null}</div>
    <section className={`market-panel ${!session ? "market-panel-intro" : ""}`}>
      {session ? <><p className="quote-key">{ended ? "Payout / result" : "Price / shares available"}</p><div className="market-columns"><span>Model</span><span>{ended ? "Payout" : "Buy"}</span><span>{ended ? "Result" : "Sell"}</span></div>
      <div className="market-outcomes" aria-label="Outcome prices">{names.map(model => {
        const rowBook = session?.market.books.find(b => b.outcome === model.seat);
        const holding = session?.market.positions.find(p => p.outcome === model.seat)?.quantity ?? 0;
        const payout = session?.market.payouts?.[model.seat] ?? 0;
        const buyShares = sharesAtQuote(rowBook, session.market.openOrders, "buy");
        const sellShares = sharesAtQuote(rowBook, session.market.openOrders, "sell");
        const detail = [model.folded ? "Folded" : ended && payout > 0 ? "Winner" : null, holding > 0 ? `You own ${holding}` : null].filter(Boolean).join(" · ");
        return <div key={model.seat} className={`market-row ${selected === model.seat ? "selected" : ""}`}>
          <button type="button" className="market-model" aria-label={`View ${model.name} market`} aria-pressed={selected === model.seat} onClick={() => selectOutcome(model.seat)}><ModelMark name={model.name} /><span className="market-model-label"><span className="market-model-name">{session.mode === "practice" ? model.name : model.modelId || model.name}</span><small className="market-row-detail">{detail ?? "\u00a0"}</small></span></button>
          {ended || readOnly ? <>
            <span className="price-box" aria-label={ended ? `Payout ${dollars(payout)}` : `Buy at ${price(rowBook?.bestAsk)}, ${buyShares} shares available`}>{ended ? payout > 0 && payout < 1 ? `1/${session.winners.length}` : price(payout) : price(rowBook?.bestAsk)}{!ended ? <small className="quote-quantity">{buyShares.toLocaleString("en-US")} sh</small> : null}</span>
            <span className="price-box sell-price" aria-label={ended ? payout > 0 ? "Winner" : "Lost" : `Sell at ${price(rowBook?.bestBid)}, buyers for ${sellShares} shares`}>{ended ? payout > 0 ? "WIN" : "—" : price(rowBook?.bestBid)}{!ended ? <small className="quote-quantity">{sellShares.toLocaleString("en-US")} sh</small> : null}</span>
          </> : <>
            <button type="button" className="price-box quote-button" aria-label={`Buy ${model.name} at ${price(rowBook?.bestAsk)}, ${buyShares} shares available`} aria-pressed={selected === model.seat && side === "buy"} onClick={() => selectOutcome(model.seat, "buy")}>{price(rowBook?.bestAsk)}<small className="quote-quantity">{buyShares.toLocaleString("en-US")} sh</small></button>
            <button type="button" className="price-box sell-price quote-button" aria-label={`Sell ${model.name} at ${price(rowBook?.bestBid)}, buyers for ${sellShares} shares`} aria-pressed={selected === model.seat && side === "sell"} onClick={() => selectOutcome(model.seat, "sell")}>{price(rowBook?.bestBid)}<small className="quote-quantity">{sellShares.toLocaleString("en-US")} sh</small></button>
          </>}
        </div>;
      })}</div></> : null}
      {!session ? <div className="intro-ticket"><p>5 hands · $1,000</p>
        <div className="mode-choices"><button type="button" className={`mode-choice ${mode === "practice" ? "active" : ""}`} aria-pressed={mode === "practice"} onClick={() => setMode("practice")}><strong>Practice</strong><small>Instant decisions</small></button><button type="button" className={`mode-choice ${mode === "live" ? "active" : ""}`} aria-pressed={mode === "live"} onClick={() => setMode("live")}><strong>Live models</strong><small>Four AI providers</small></button></div>
        {mode === "live" && !bootstrap?.liveAvailable ? <div className="live-unavailable">{bootstrap?.liveUnavailableReason ?? "Live providers are not connected yet. Practice is ready to play."}</div> : null}
        <div className="setup-options">
          <div className="setup-option">
            <label className="ranked-choice"><input type="checkbox" checked={personalitiesEnabled} disabled={busy} aria-describedby="personality-description" onChange={e => setPersonalitiesEnabled(e.target.checked)} /><span>Enable personalities</span></label>
            <p className="setup-option-description" id="personality-description">{personalitiesEnabled ? "Shark, Bully, Maniac, and Opportunist are assigned for all five hands." : "No assigned playing styles. Models play without personality instructions."}</p>
          </div>
          {bootstrap?.authenticated && bootstrap.profile ? <label className="ranked-choice"><input type="checkbox" checked={ranked} onChange={e => setRanked(e.target.checked)} /><span>Enter weekly leaderboard</span><small className="attempts-remaining">{bootstrap.profile.remainingAttempts} attempts left</small></label> : null}
        </div>
        {mode === "live" && bootstrap?.liveAvailable && !bootstrap.authenticated ? <a className="primary-button wide" href="/signin-with-chatgpt?return_to=/" target="_top">Sign in for live models</a> : <button type="button" className="primary-button wide" disabled={busy || !bootstrap || mode === "live" && !bootstrap.liveAvailable || ranked && !bootstrap.profile?.remainingAttempts} onClick={async () => { if (await onStart?.(mode, ranked, personalitiesEnabled)) setPersonalitiesEnabled(false); }}>{busy ? "Starting…" : mode === "live" ? "Start live challenge" : "Start practice challenge"}</button>}
        {!bootstrap?.authenticated ? <p className="login-hint"><a href="/signin-with-chatgpt?return_to=/" target="_top">Sign in</a> to enter the leaderboard.</p> : !bootstrap.profile ? <p className="login-hint">Choose a username in your profile to enter ranked challenges.</p> : <p className="login-hint">{ranked ? "Ranked attempts count when a challenge starts." : "Unranked. No weekly attempt used."}</p>}

      </div> : readOnly ? <div className="trade-ticket settlement-ticket"><span className="eyebrow">RECORDED MARKET</span><h3>{ended ? session.results.at(-1)?.description ?? "This hand has settled." : "Market prices at this step"}</h3><div className="trade-details"><div><span>Your recorded balance</span><strong>{dollars(session.market.cash)}</strong></div>{ended ? <div><span>This hand’s PnL</span><strong>{signed(session.results.at(-1)?.pnl ?? 0)}</strong></div> : null}</div><p>Replay is read-only. Use the playback controls to explore this game.</p>{lastTrade ? <p className="trade-feedback"><Check size={11} /><span>{lastTrade.text}</span></p> : null}</div> : ended ? <div className="trade-ticket settlement-ticket"><span className="eyebrow">Hand {session.hand} settled</span><h3>{session.results.at(-1)?.description ?? "This hand is complete."}</h3><div className="trade-details"><div><span>This hand’s PnL</span><strong className={(session.results.at(-1)?.pnl ?? 0) < 0 ? "negative" : "positive"}>{signed(session.results.at(-1)?.pnl ?? 0)}</strong></div><div><span>Your balance</span><strong>{dollars(session.market.cash)}</strong></div></div>{session.status === "hand_complete" ? <p className="ticket-note">{paused ? "Press Play to deal the next hand." : "The next hand deals automatically."}</p> : <p className="ticket-note">Five hands complete.</p>}</div> : <div className="trade-ticket" onFocusCapture={() => holdQuote()} onPointerDownCapture={() => holdQuote()}>
        <div className="ticket-top"><h3>{selectedPlayer?.name} shares</h3><div className="trade-tabs" aria-label="Trade side"><button className={`trade-tab ${side === "buy" ? "active" : ""}`} type="button" aria-pressed={side === "buy"} onClick={() => { setSide("buy"); setQuote(null); setTicketError(null); }}>Buy</button><button className={`trade-tab ${side === "sell" ? "active" : ""}`} type="button" aria-pressed={side === "sell"} onClick={() => { setSide("sell"); setQuote(null); setTicketError(null); }}>Sell</button></div></div>
        {outcomeClosed ? <p className="ticket-error" role="status">{selectedPlayer?.name} folded. These shares pay $0 and can no longer be traded.</p> : null}
        <div className="ticket-availability"><div><span>{side === "buy" ? "For sale" : "Buyers for"} within {price(quickPrice)}</span><strong>{availableAtQuote.toLocaleString("en-US")} shares</strong></div><div><span>You own</span><strong>{position?.quantity ?? 0} shares{position && position.availableQuantity < position.quantity ? <small>{position.availableQuantity} available to sell</small> : null}</strong></div></div>
        <label className="field-label" htmlFor="order-type">Order type <span>{orderType === "ioc" ? "Unfilled shares cancel" : "Can carry across actions"}</span></label><select className="select-input" id="order-type" disabled={outcomeClosed} value={orderType} onChange={e => { setOrderType(e.target.value as "ioc" | "limit"); setTicketError(null); }}><option value="ioc">Buy / sell at displayed quote</option><option value="limit">Limit order</option></select>
        <label className="field-label" htmlFor="trade-quantity">Quantity <span>{side === "buy" ? `${dollars(session.market.availableCash)} available` : `${position?.availableQuantity ?? 0} shares available`}</span></label><div className="input-with-unit"><input className="text-input" id="trade-quantity" aria-invalid={Boolean(preview.quantityError)} aria-describedby={preview.quantityError ? "trade-validation" : undefined} disabled={outcomeClosed} type="number" inputMode="numeric" min="1" max="100000" step="1" value={quantity} onChange={e => { setQuantity(e.target.value); setTicketError(null); }} /><span>shares</span></div><div className="quick-amounts" aria-label="Share quantity presets">{[10, 25, 50, 100].map(q => <button type="button" key={q} disabled={outcomeClosed} onClick={() => { setQuantity(String(q)); setTicketError(null); }}>{q}</button>)}</div>
        {orderType === "limit" ? <><label className="field-label" htmlFor="limit-price">{side === "buy" ? "Maximum buy price" : "Minimum sell price"}</label><div className="input-with-unit"><input className="text-input" id="limit-price" aria-invalid={Boolean(preview.priceError)} aria-describedby={preview.priceError ? "trade-validation" : undefined} disabled={outcomeClosed} type="number" inputMode="numeric" min="1" max="99" step="1" value={limit} onChange={e => { setLimit(e.target.value); setTicketError(null); }} /><span>cents</span></div></> : null}
        <div className="trade-details"><div><span>{side === "buy" ? "Maximum buy price" : "Minimum sale price"}</span><strong>{price(preview.price)}</strong></div><div><span title={equityDescription(session.odds)}>Showdown equity</span><strong>{percent(session.odds.equities[selected])}</strong></div><div><span>{side === "buy" ? "Maximum cost" : "Proceeds if fully filled"}</span><strong>{preview.total == null ? "—" : dollars(preview.total)}</strong></div>{side === "buy" ? <div><span>Payout if all {preview.quantity ?? "shares"} win outright</span><strong>{preview.quantity == null ? "—" : dollars(preview.quantity)}</strong></div> : null}</div>
        {orderType === "ioc" || draftStale ? <p className={`ticket-fill-note ${draftStale ? "ticket-error" : ""}`}>
          {draftStale ? <>The hand changed. Review this market. <button type="button" className="text-button" onClick={() => holdQuote(true)} disabled={busy}>Use hand {session.hand}</button></> : <>
            {preview.quantity != null && availableAtQuote < preview.quantity && preview.price != null ? `Only ${availableAtQuote} of ${preview.quantity} shares within this limit. ` : ""}Unfilled shares cancel. {quoteHeld ? <>Limit held. <button type="button" className="text-button" onClick={() => holdQuote(true)} disabled={busy}>Refresh price</button></> : "Limit locks while editing."}
          </>}
        </p> : null}
        {ticketError || inputError ? <p className="ticket-error" id="trade-validation" role="alert">{ticketError ?? inputError}</p> : null}
        <button type="button" className="primary-button wide" disabled={busy || unavailable || draftStale || noQuote || invalidDraft || insufficient} onClick={() => void submitOrder()}>{ended ? "Hand settled" : outcomeClosed ? "Model folded" : paused ? "Press Play to trade" : unavailable ? "Trading window closed" : draftStale ? "Review the new hand" : noQuote ? "No quote available" : invalidDraft ? "Check order details" : insufficient ? side === "buy" ? "Not enough cash" : "Not enough shares" : busy ? "Submitting…" : `${side === "buy" ? "Buy" : "Sell"} ${orderType === "ioc" ? "up to " : ""}${preview.quantity ?? 0} shares`}</button>
        <details className="ticket-rules"><summary>Contract rules</summary><p>Shares pay $1 to the sole main-pot winner; ties split that dollar. Partial fills are possible. Showdown equity assumes no further folds.</p></details>
      </div>}
    </section>
    {!readOnly && !ended && lastTrade && dismissedTrade !== lastTrade.id ? <div className="order-update">
      <div className="trade-feedback"><span className="trade-feedback-label">Last order update · <time dateTime={lastTrade.at}>{new Date(lastTrade.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time></span><p>{lastTrade.text}</p></div>
      <button type="button" aria-label="Dismiss order update" onClick={() => setDismissedTrade(lastTrade.id)}><X size={14} /></button>
    </div> : null}
    {session && showOrderBook ? <OrderBook book={book} name={selectedPlayer?.name} settled={ended} traderEngine={session.market.driver} agentNotice={session.market.agentNotice} /> : null}
  </aside>;
}
