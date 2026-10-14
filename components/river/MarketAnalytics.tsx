"use client";

import { marketPriceDisplay } from "../../lib/market-display";
import { useEffect, useId, useRef, useState } from "react";
import type { SessionView, ShowdownOdds } from "../../app/types";
import type { MarketBookView, MarketDriver } from "../../lib/market";
import "./market-analytics.css";

const LINE_COLORS = ["#245c45", "#9a6028", "#495a8b", "#9e3f32"];
const HEIGHT = 194;
const LEFT = 6;
const TOP = 8;
const BOTTOM = HEIGHT - 26;

export function getShowdownOdds(session: SessionView | null): ShowdownOdds | undefined {
  return session?.odds;
}

export function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

export function equityDescription(odds: ShowdownOdds | undefined): string {
  const assumption = "Expected share of the main pot at showdown, assuming no further folds. Ties split the pot.";
  if (!odds) return assumption;
  return `${assumption} ${odds.method === "exact" ? "Exact card calculation or settled payout." : `${odds.samples.toLocaleString()} sampled boards; maximum standard error ${(odds.standardError * 100).toFixed(1)} percentage points (one standard deviation).`}`;
}

/** History is recorded from the book midpoint, or the last trade when a side is empty. */
export function MarketAnalytics({ session }: { session: SessionView | null }) {
  const containerRef = useRef<HTMLElement>(null);
  const tooltipId = useId();
  const [chartWidth, setChartWidth] = useState(620);
  const [hoveredTick, setHoveredTick] = useState<number | null>(null);
  const hasSession = session !== null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = (width: number) => {
      if (width > 0) setChartWidth(width);
    };
    updateWidth(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [hasSession]);

  if (!session) return null;
  const right = Math.max(LEFT, chartWidth - 48);
  const { current: marks, history } = marketPriceDisplay(session.market, session.players.map(player => !player.folded));
  const odds = getShowdownOdds(session);
  const firstTick = history[0]?.tick ?? 0;
  const lastTick = history.at(-1)?.tick ?? firstTick;
  const span = Math.max(1, lastTick - firstTick);
  const x = (tick: number) => LEFT + (tick - firstTick) / span * (right - LEFT);
  const y = (value: number) => BOTTOM - value * (BOTTOM - TOP);
  const paths = session.players.map(player => {
    let connected = false;
    return history.map(point => {
      const value = point.prices[player.seat];
      if (value == null) { connected = false; return ""; }
      const command = connected ? "L" : "M";
      connected = true;
      return `${command}${x(point.tick).toFixed(2)},${y(value).toFixed(2)}`;
    }).join(" ");
  });

  const inspected = hoveredTick == null ? undefined : history.find(point => point.tick === hoveredTick);
  const inspectAt = (clientX: number, bounds: DOMRect) => {
    const chartX = (clientX - bounds.left) * chartWidth / bounds.width;
    const tick = firstTick + Math.max(0, Math.min(1, (chartX - LEFT) / Math.max(1, right - LEFT))) * span;
    const nearest = history.reduce<(typeof history)[number] | undefined>((best, point) => !best || Math.abs(point.tick - tick) < Math.abs(best.tick - tick) ? point : best, undefined);
    setHoveredTick(nearest?.tick ?? null);
  };

  return <section ref={containerRef} className="market-analytics" aria-label="Market prices and mathematical showdown equity">
    <div className="analytics-heading"><h2>Market prices</h2><span>Hand {session.hand}</span></div>
    <div className="market-chart-wrap">
    <svg aria-describedby={inspected ? tooltipId : undefined} tabIndex={0} onPointerMove={event => inspectAt(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHoveredTick(null)} onFocus={() => setHoveredTick(history.at(-1)?.tick ?? null)} onBlur={() => setHoveredTick(null)} onKeyDown={event => {
      if (event.key === "Escape") { setHoveredTick(null); return; }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !history.length) return;
      event.preventDefault();
      const index = history.findIndex(point => point.tick === hoveredTick);
      const next = event.key === "Home" ? 0 : event.key === "End" ? history.length - 1 : Math.max(0, Math.min(history.length - 1, (index < 0 ? history.length - 1 : index) + (event.key === "ArrowLeft" ? -1 : 1)));
      setHoveredTick(history[next].tick);
    }} className="market-price-chart" viewBox={`0 0 ${chartWidth} ${HEIGHT}`} height={HEIGHT} preserveAspectRatio="none" role="img" aria-label={`Market price history for hand ${session.hand}. Hover to see named prices at each time, or focus and use the arrow keys. Current prices and mathematical equity are listed below.`}>
      <title>Outcome prices from the order book</title>
      <desc>Four lines show actual market history. Gaps indicate there was no midpoint or previous trade. Prices can differ from mathematical showdown equity.</desc>
      {[0, .25, .5, .75, 1].map(value => <g key={value}><line className="chart-grid-line" x1={LEFT} x2={right} y1={y(value)} y2={y(value)} /><text className="chart-axis-label" x={right + 8} y={y(value) + 3}>{value * 100}%</text></g>)}
      {session.players.map((player, i) => {
        const latest = history.at(-1);
        const value = latest?.prices[player.seat];
        return <g key={player.seat}><path d={paths[i]} stroke={LINE_COLORS[player.seat % LINE_COLORS.length]} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />{value != null && latest ? <circle cx={x(latest.tick)} cy={y(value)} r="3" fill={LINE_COLORS[player.seat % LINE_COLORS.length]} stroke="#ffffff" strokeWidth="1" /> : null}</g>;
      })}
      {inspected ? <g className="chart-inspection" aria-hidden="true"><line x1={x(inspected.tick)} x2={x(inspected.tick)} y1={TOP} y2={BOTTOM} />{session.players.map(player => {
        const value = inspected.prices[player.seat];
        return value == null ? null : <circle key={player.seat} cx={x(inspected.tick)} cy={y(value)} r="4" fill={LINE_COLORS[player.seat % LINE_COLORS.length]} stroke="#fff" strokeWidth="1.5" />;
      })}</g> : null}
      <text className="chart-axis-label" x={LEFT} y={HEIGHT - 5}>{firstTick}s</text>
      {lastTick > firstTick ? <text className="chart-axis-label" x={right} y={HEIGHT - 5} textAnchor="end">{lastTick}s</text> : null}
      <text className="chart-axis-label" x={(LEFT + right) / 2} y={HEIGHT - 5} textAnchor="middle">Market time</text>
    </svg>
    {inspected ? <div className="chart-price-tooltip" id={tooltipId} role="tooltip" style={{ left: Math.max(0, Math.min(chartWidth - 190, x(inspected.tick) + 12)) }}>
      <strong>Market prices · {inspected.tick}s{inspected.tick < session.market.tick ? " · Historical" : ""}</strong>
      {session.players.map(player => <div key={player.seat}><span><i aria-hidden="true" style={{ background: LINE_COLORS[player.seat % LINE_COLORS.length] }} />{player.name}</span><b>{percent(inspected.prices[player.seat])}</b></div>)}
    </div> : null}
    </div>
    <div className="analytics-comparison" role="table" aria-label="Current market prices compared with mathematical showdown equity">
      <div className="analytics-table-row analytics-table-head" role="row"><span role="columnheader">Model</span><span role="columnheader">{session.market.status === "settled" ? "Payout" : "Market"}</span><span role="columnheader">Showdown equity</span></div>
      {session.players.map(player => {
        const market = marks[player.seat];
        return <div className="analytics-table-row" role="row" key={player.seat}><span className="analytics-model" role="cell"><i aria-hidden="true" style={{ backgroundColor: LINE_COLORS[player.seat % LINE_COLORS.length] }} />{player.name}</span><strong role="cell">{percent(market)}</strong><strong role="cell">{percent(odds?.equities[player.seat])}</strong></div>;
      })}
    </div>
    <details className="analytics-method"><summary>Equity assumes no further folds</summary><p>Market marks use the bid–ask midpoint, or the last trade when a side is empty. Folded outcomes mark at zero; actual last executions remain unchanged. Earlier chart points show their historical marks. {equityDescription(odds)}</p></details>
  </section>;
}

export function OrderBook({ book, name, settled, traderEngine, agentNotice, recordedAt }: { book: MarketBookView | undefined; name: string | undefined; settled: boolean; traderEngine?: MarketDriver; agentNotice?: string | null; recordedAt?: { hand: number; tick: number } }) {
  const bids = book?.bids.slice(0, 6) ?? [];
  const asks = book?.asks.slice(0, 6) ?? [];
  const maxQuantity = Math.max(1, ...bids.map(level => level.quantity), ...asks.map(level => level.quantity));
  const spread = book?.bestAsk != null && book.bestBid != null ? Math.round((book.bestAsk - book.bestBid) * 100) : null;
  return <section className="clob-panel" aria-label={`Order book for ${name ?? "selected model"}`}>
    <div className="clob-heading"><h3>{recordedAt ? "Historical Order Book" : "Order book"} <span>{name}</span></h3><span>{recordedAt ? `Hand ${recordedAt.hand} · ${recordedAt.tick}s · ${settled ? "Settled" : "Recorded"}` : settled ? "Settled" : spread == null ? "No two-sided quote" : `${spread}¢ spread`}</span></div>
    {traderEngine === "jev" && !recordedAt ? <p className="clob-agent-status" role="status">{settled ? "Jev trading complete. Orders settled." : agentNotice ?? "Orders chosen by Jev · Play money only."}</p> : null}
    <div className="clob-columns">{([{ label: "Bids", levels: bids, kind: "bid" }, { label: "Asks", levels: asks, kind: "ask" }] as const).map(side => <div className={`clob-side clob-${side.kind}`} key={side.kind}>
      <div className="clob-column-head"><strong>{side.label}</strong><span>Shares</span></div>
      {side.levels.length ? side.levels.map(level => <div className="clob-level" key={level.price}><i className="clob-volume" aria-hidden="true" style={{ width: `${100 * level.quantity / maxQuantity}%` }} /><span>{recordedAt ? `${Math.round(level.price * 100)}¢` : percent(level.price)}</span><span>{level.quantity.toLocaleString()}</span></div>) : <p className="clob-empty">{recordedAt ? settled ? "Orders closed at settlement." : `No ${side.label.toLowerCase()} recorded at this step.` : settled ? "—" : `No ${side.label.toLowerCase()}`}</p>}
    </div>)}</div>
    <p className="clob-caption">{recordedAt ? settled ? "Orders closed at settlement. Step back to inspect earlier quotes." : "Top 6 recorded price levels per side · Prices per share · Read-only snapshot" : "1% = 1¢ per share · Bars show available shares"}</p>
  </section>;
}
