"use client";

import { useState } from "react";
import type { SessionView } from "../../app/types";
import type { TraderKind } from "../../lib/market";
import "./trader-activity.css";

const KINDS: TraderKind[] = ["maker", "fundamental", "equity", "momentum", "contrarian", "noise", "arbitrage"];
const KIND_DESCRIPTIONS: Record<TraderKind, string> = {
  arbitrage: "Buys underpriced complete sets or sells overpriced complete sets using funded collateral.",
  maker: "Quotes both sides and manages inventory.",
  fundamental: "Trades differences from its estimated outcome value.",
  equity: "Trades a softened estimate of outcome value.",
  momentum: "Follows recent price moves.",
  contrarian: "Trades against recent price moves.",
  noise: "Trades with noisy beliefs and varied timing.",
};

function shares(value: number | null | undefined, signed = false): string {
  if (value == null) return "—";
  return `${signed && value > 0 ? "+" : ""}${value.toLocaleString()}`;
}

export function TraderActivity({ session }: { session: SessionView | null }) {
  const [view, setView] = useState<"net" | "holdings">("net");
  if (!session) return null;
  const traders = session.market.traderPositions ?? [];
  const trades = session.market.recentTrades ?? [];
  const settled = session.market.status === "settled";
  const totalVolume = session.market.books.reduce((sum, book) => sum + book.volume, 0);

  return <section className="trader-activity" aria-label="Synthetic trader positions and executed trades">
    <div className="trader-activity-heading">
      <div><h2>Trader positions</h2><p>{traders.filter(t=>t.kind!=="arbitrage").length} {session.market.driver === "jev" ? "Jev traders" : "simulated traders"}{traders.some(t=>t.kind==="arbitrage") ? " + complete-set arbitrage" : ""} · {totalVolume.toLocaleString()} shares traded</p></div>
    </div>
    <details className="trader-details">
      <summary>Trader details</summary>
      <div className="trader-view-switch" role="group" aria-label="Position display">
        <button type="button" aria-pressed={view === "net"} onClick={() => setView("net")}>Net trades</button>
        <button type="button" aria-pressed={view === "holdings"} onClick={() => setView("holdings")}>Holdings</button>
      </div>
    <p className="trader-view-note">{view === "net" ? "Bought − sold this hand." : "Shares owned, including starting inventory."}{settled ? " Holdings redeemed; orders closed." : ""}</p>
    {traders.length ? <div className="trader-table-scroll" tabIndex={0} role="region" aria-label="All trader positions, scroll to see more">
      <table className="trader-positions-table">
        <caption className="sr-only">{view === "net" ? "Net filled shares, excluding seeded inventory" : "Current shares owned"} for hand {session.hand}. Orders are the number of open orders.</caption>
        <thead><tr><th scope="col">Trader</th>{session.players.map(player => <th key={player.seat} scope="col">{player.name}</th>)}<th scope="col" title="Open, unfilled orders">Orders</th></tr></thead>
        {KINDS.map(kind => <tbody key={kind} className="trader-kind-group">{traders.filter(trader => trader.kind === kind).map(trader => <tr key={trader.id}>
          <th scope="row" title={KIND_DESCRIPTIONS[kind]}>{trader.name}</th>
          {session.players.map(player => {
            const value = view === "net" ? trader.netFilledShares?.[player.seat] : trader.holdings[player.seat];
            return <td key={player.seat} className={view === "net" && value ? value > 0 ? "trader-net-buy" : "trader-net-sell" : value === 0 ? "trader-zero" : undefined}>{shares(value, view === "net")}</td>;
          })}
          <td className="trader-order-count">{trader.openOrders}</td>
        </tr>)}</tbody>)}
      </table>
    </div> : <p className="trader-empty">Trader positions are available after the next market update.</p>}
    {view === "net" && traders.some(trader => trader.netFilledShares === null) ? <p className="trader-view-note">Net trades were not retained for this earlier settled hand.</p> : null}
    {view === "holdings" ? <details className="trader-method"><summary>Starting inventory</summary><p>New makers and the complete-set arbitrage agent start with 2,000 shares per outcome; other traders start with 240. Earlier games retain their original inventory. Orders are unfilled quotes.</p></details> : null}
    </details>
    <div className="trader-tape-heading"><h3>Latest fills</h3><span>Buyer ← seller</span></div>
    {trades.length ? <ol className="trader-tape">{trades.slice(0, 6).map(trade => {
      const model = session.players.find(player => player.seat === trade.outcome)?.name ?? `Outcome ${trade.outcome + 1}`;
      const yourTrade = trade.buyer.id === "human" || trade.seller.id === "human";
      return <li key={trade.id} className={yourTrade ? "trader-fill-your" : undefined} aria-label={`${trade.buyer.name} bought ${trade.quantity} ${model} shares from ${trade.seller.name} at ${Math.round(trade.price * 100)} cents per share at market second ${trade.tick}`}>
        <div className="trader-fill-parties"><strong>{trade.buyer.name}</strong><span aria-hidden="true">←</span><span>{trade.seller.name}</span></div>
        <div className="trader-fill-detail"><span>{model} · {trade.quantity} shares @ {Math.round(trade.price * 100)}¢</span><span className="trader-fill-time">{trade.tick}s</span></div>
      </li>;
    })}</ol> : <p className="trader-empty">No fills yet. Quotes can move before a trade matches.</p>}
  </section>;
}
