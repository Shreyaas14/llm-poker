"use client";

import { useId, useState } from "react";
import { PlayingCard } from "./PlayingCard";
import "./poker-table.css";

export type TableSeat = {
  id: string; name: string; cards: string[]; stack: number; action: string;
  folded: boolean; active: boolean; dealer: boolean; winner: boolean; description: string;
  classId?: string | null; className?: string | null; allIn?: boolean;
};

export const MODEL_SEATS: TableSeat[] = ["GPT", "Claude", "Gemini", "Grok"].map(name => ({
  id: name.toLowerCase(), name, cards: [], stack: 1000, action: "Ready", folded: false,
  active: false, dealer: false, winner: false, description: "Personalities can be enabled before starting a new challenge.",
}));

function PlayerClass({ name, description }: { name?: string | null; description: string }) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  if (!name) return null;
  return <div className="seat-class-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button className="seat-class" type="button" aria-describedby={tooltipId}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } }}>
      {name}
    </button>
    <span className="seat-class-tooltip" id={tooltipId} role="tooltip" hidden={!open}>{description}</span>
  </div>;
}

export function PokerTable({ seats, board, pot, street, started, busy, settled, winningCards = [] }: {
  seats: TableSeat[]; board: string[]; pot: number; street: string; started: boolean; busy: boolean; settled: boolean; winningCards?: string[];
}) {
  const acting = seats.find(seat => seat.active && !seat.folded);
  const turnLabel = !started ? "Ready to deal" : settled ? "Hand settled" : acting ? `${acting.name} ${busy ? "is deciding…" : "to act"}` : busy ? "Resolving hand…" : "Waiting for next action";
  return <section className="table-panel vesper-table" aria-label={`Poker table, ${street.replaceAll("_", " ")}`}>
    <div className="table-turn-status" role="status" aria-live="polite">{turnLabel}</div>
    <div className="board-area">
      <div className="board-cards" role="group" aria-label="Community cards">{Array.from({ length: 5 }, (_, i) => <PlayingCard key={i} card={board[i]} winning={winningCards.includes(board[i])} ghost />)}</div>
      <div className="board-pot"><span>Pot</span><strong>{pot.toLocaleString()}</strong></div>
    </div>
    <div className="seats-grid">{seats.map((seat, i) => {
      const state = seat.winner ? "Winner" : seat.folded ? "Folded" : seat.allIn ? "All-in" : seat.active && !settled ? "To act" : null;
      return <article className={`player-seat seat-${i} ${seat.active && !settled ? "seat-active" : ""} ${seat.folded ? "seat-folded" : ""} ${seat.winner ? "seat-winner" : ""} ${seat.allIn ? "seat-all-in" : ""}`} key={seat.id} aria-label={`${seat.name}${state ? `, ${state.toLowerCase()}` : ""}`}>
        <div className="seat-identity"><div><h3>{seat.name}{seat.dealer && started ? <span className="dealer-button" title="Dealer" aria-label="Dealer">D</span> : null}</h3>{started ? <span>{seat.stack.toLocaleString()} chips</span> : null}</div>{state ? <span className="seat-state">{state}</span> : null}</div>
        <div className="seat-hand"><PlayingCard card={seat.cards[0]} winning={seat.winner && winningCards.includes(seat.cards[0])} small /><PlayingCard card={seat.cards[1]} winning={seat.winner && winningCards.includes(seat.cards[1])} small />{started && !seat.folded && !seat.winner ? <span className="seat-action">{seat.active && busy ? "Deciding…" : seat.action}</span> : null}</div>
        <PlayerClass name={started ? seat.className : undefined} description={seat.description} />
      </article>;
    })}</div>
  </section>;
}
