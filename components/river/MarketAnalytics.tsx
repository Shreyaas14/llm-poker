"use client";

import { CircleHelp } from "lucide-react";
import type { SessionView, ShowdownOdds } from "../../app/types";
import type { MarketBookView } from "../../lib/market";
import "./market-analytics.css";

const LINE_COLORS = ["#33755b", "#bf7041", "#557ac0", "#9466a5"];
const WIDTH = 620;
const HEIGHT = 194;
const LEFT = 6;
const RIGHT = WIDTH - 41;
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
  if (!session) return null;
  const history = session.market.history;
  const odds = getShowdownOdds(session);
  const firstTick = history[0]?.tick ?? 0;
  const lastTick = history.at(-1)?.tick ?? firstTick;
  const span = Math.max(1, lastTick - firstTick);
  const x = (tick: number) => LEFT + (tick - firstTick) / span * (RIGHT - LEFT);
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

  return <section className="market-analytics" aria-label="Market prices and mathematical showdown equity">
    <div className="analytics-heading"><h2>Market prices</h2><span>Hand {session.hand}</span></div>
    <svg className="market-price-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Market price history for hand ${session.hand}. Current prices and mathematical equity are listed below.`}>
      <title>Outcome prices from the order book</title>
      <desc>Four lines show actual market history. Gaps indicate there was no midpoint or previous trade. Prices can differ from mathematical showdown equity.</desc>
      {[0, .25, .5, .75, 1].map(value => <g key={value}><line className="chart-grid-line" x1={LEFT} x2={RIGHT} y1={y(value)} y2={y(value)} /><text className="chart-axis-label" x={RIGHT + 8} y={y(value) + 3}>{value * 100}%</text></g>)}
      {session.players.map((player, i) => {
        const latest = history.at(-1);
        const value = latest?.prices[player.seat];
        return <g key={player.seat}><path d={paths[i]} stroke={LINE_COLORS[player.seat % LINE_COLORS.length]} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />{value != null && latest ? <circle cx={x(latest.tick)} cy={y(value)} r="3" fill={LINE_COLORS[player.seat % LINE_COLORS.length]} stroke="#fffefa" strokeWidth="1" /> : null}</g>;
      })}
      <text className="chart-axis-label" x={LEFT} y={HEIGHT - 5}>{firstTick}s</text>
      {lastTick > firstTick ? <text className="chart-axis-label" x={RIGHT} y={HEIGHT - 5} textAnchor="end">{lastTick}s</text> : null}
      <text className="chart-axis-label" x={(LEFT + RIGHT) / 2} y={HEIGHT - 5} textAnchor="middle">Market time</text>
    </svg>
    <div className="analytics-comparison" role="table" aria-label="Current market prices compared with mathematical showdown equity">
      <div className="analytics-table-row analytics-table-head" role="row"><span role="columnheader">Model</span><span role="columnheader">{session.market.status === "settled" ? "Payout" : "Market"}</span><span role="columnheader">Showdown equity <span className="equity-help" tabIndex={0} title={equityDescription(odds)} aria-label={equityDescription(odds)}><CircleHelp size={11} /></span></span></div>
      {session.players.map(player => {
        const book = session.market.books.find(b => b.outcome === player.seat);
        const market = session.market.status === "settled" ? session.market.payouts?.[player.seat] : book?.midpoint ?? book?.lastPrice;
        return <div className="analytics-table-row" role="row" key={player.seat}><span className="analytics-model" role="cell"><i aria-hidden="true" style={{ backgroundColor: LINE_COLORS[player.seat % LINE_COLORS.length] }} />{player.name}</span><strong role="cell">{percent(market)}</strong><strong role="cell">{percent(odds?.equities[player.seat])}</strong></div>;
      })}
    </div>
    <p className="analytics-method">Market: bid–ask midpoint, or last trade. Equity: {odds?.method === "exact" ? "exact" : odds ? "Monte Carlo estimate" : "calculating"}, assuming no further folds; ties split.</p>
  </section>;
}

export function OrderBook({ book, name, settled }: { book: MarketBookView | undefined; name: string | undefined; settled: boolean }) {
  const bids = book?.bids.slice(0, 6) ?? [];
  const asks = book?.asks.slice(0, 6) ?? [];
  const maxQuantity = Math.max(1, ...bids.map(level => level.quantity), ...asks.map(level => level.quantity));
  const spread = book?.bestAsk != null && book.bestBid != null ? Math.round((book.bestAsk - book.bestBid) * 100) : null;
  return <section className="clob-panel" aria-label={`Order book for ${name ?? "selected model"}`}>
    <div className="clob-heading"><h3>Order book <span>{name}</span></h3><span>{settled ? "Settled" : spread == null ? "No two-sided quote" : `${spread}¢ spread`}</span></div>
    <div className="clob-columns">{([{ label: "Bids", levels: bids, kind: "bid" }, { label: "Asks", levels: asks, kind: "ask" }] as const).map(side => <div className={`clob-side clob-${side.kind}`} key={side.kind}>
      <div className="clob-column-head"><strong>{side.label}</strong><span>Shares</span></div>
      {side.levels.length ? side.levels.map(level => <div className="clob-level" key={level.price}><i className="clob-volume" aria-hidden="true" style={{ width: `${100 * level.quantity / maxQuantity}%` }} /><span>{percent(level.price)}</span><span>{level.quantity.toLocaleString()}</span></div>) : <p className="clob-empty">{settled ? "—" : `No ${side.label.toLowerCase()}`}</p>}
    </div>)}</div>
    <p className="clob-caption">1% = 1¢ per share · Bars show available shares</p>
  </section>;
}
