"use client";

import type { SessionView } from "../../app/types";
import { dollars, price, signed } from "./MarketPanel";
import "./positions-strip.css";

export function PositionsStrip({ session, readOnly = false }: { session: SessionView; readOnly?: boolean }) {
  const settled = session.market.status === "settled";

  return <section className="positions-strip" aria-label={readOnly ? "Your recorded positions" : "Your positions"}>
    <div className="positions-strip-heading">
      <h2>{readOnly ? "Recorded positions" : "Your positions"}</h2>
      <span>{settled ? "Shares redeemed" : `Hand ${session.hand}`}</span>
    </div>
    <div className="positions-strip-grid">
      {session.players.map(player => {
        const position = session.market.positions.find(item => item.outcome === player.seat);
        const quantity = position?.quantity ?? 0;
        const reserved = Math.max(0, quantity - (position?.availableQuantity ?? 0));
        const withoutBids = position?.unliquidatedQuantity ?? 0;
        const pnl = position?.unrealizedPnl ?? 0;
        const notes = [reserved > 0 ? `${reserved.toLocaleString()} reserved` : null, withoutBids > 0 ? `${withoutBids.toLocaleString()} without bids` : null].filter(Boolean).join(" · ");

        return <div className={`positions-strip-item ${quantity === 0 ? "positions-strip-empty" : ""}`} key={player.seat}>
          <div className="positions-strip-item-heading">
            <h3>{player.name}</h3>
            <div className="positions-strip-quantity">
              <strong>{quantity.toLocaleString()}</strong><span aria-hidden="true">sh</span><span className="sr-only">shares owned</span>
            </div>
          </div>
          <div className="positions-strip-details">
            <div className="positions-strip-detail"><span>Avg</span><span>{quantity > 0 ? price(position?.averageCost) : "—"}</span></div>
            <div className="positions-strip-detail" title={quantity > 0 ? `${dollars(position?.liquidationValue ?? 0)} at available bids. Unrealized PnL is this value minus the cost of your shares.` : undefined}>
              <span>PnL</span><span className={quantity > 0 ? pnl < 0 ? "negative" : "positive" : undefined}>{quantity > 0 ? signed(pnl) : "—"}</span>
            </div>
          </div>
          <p className="positions-strip-note" title={notes || undefined}>{notes || "\u00a0"}</p>
        </div>;
      })}
    </div>
  </section>;
}
