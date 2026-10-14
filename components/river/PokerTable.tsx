"use client";

import { useId, useState } from "react";
import { CircleHelp, Layers3 } from "lucide-react";
import { PlayingCard } from "./PlayingCard";
import "./poker-table.css";

export type TableSeat = {
  id: string; name: string; cards: string[]; stack: number; action: string;
  folded: boolean; active: boolean; dealer: boolean; winner: boolean; description: string;
  classId?: string; className?: string; allIn?: boolean;
};

export const MODEL_SEATS: TableSeat[] = ["GPT", "Claude", "Gemini", "Grok"].map(name => ({
  id: name.toLowerCase(), name, cards: [], stack: 1000, action: "Ready", folded: false,
  active: false, dealer: false, winner: false, description: "A playing style is randomly assigned when a new game starts.",
}));

export function ModelMark({ name }: { name: string }) {
  const lower = name.toLowerCase();
  return <span aria-hidden="true" className={`model-mark model-${lower.includes("gpt") ? "gpt" : lower.includes("claude") ? "claude" : lower.includes("gemini") ? "gemini" : "grok"}`}>{lower.includes("claude") ? "✳" : lower.includes("gemini") ? "✦" : lower.includes("gpt") ? "◎" : "╱"}</span>;
}

function PlayerClass({ name, description }: { name?: string; description: string }) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  if (!name) return <span className="seat-class-unassigned">Class drawn at deal</span>;
  return <div className="seat-class-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button className="seat-class" type="button" aria-describedby={tooltipId}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } }}>
      {name}<CircleHelp size={10} aria-hidden="true" />
    </button>
    <span className="seat-class-tooltip" id={tooltipId} role="tooltip" hidden={!open}>{description}</span>
  </div>;
}

export function PokerTable({ seats, board, pot, street, started, busy, settled, winningCards = [] }: {
  seats: TableSeat[]; board: string[]; pot: number; street: string; started: boolean; busy: boolean; settled: boolean; winningCards?: string[];
}) {
  const acting = seats.find(seat => seat.active && !seat.folded);
  const turnLabel = !started ? "Ready to deal" : settled ? "Hand settled" : acting ? `${acting.name} ${busy ? "is deciding…" : "to act"}` : busy ? "Resolving hand…" : "Waiting for next action";
  return <section className="table-panel vesper-table" aria-label="Poker table">
    <div className="table-corner-label"><span className={`status-dot ${started && !settled ? "status-dot-live" : ""}`} />{!started ? "VESPER" : street.replaceAll("_", " ")}</div>
    <div className={`table-turn-status ${acting && !settled ? "is-acting" : ""}`} role="status" aria-live="polite">{turnLabel}</div>
    <div className="poker-felt"><div className="felt-inner" />
      <div className="board-area">
        <h3 className="board-heading">Board <span>Community cards</span></h3>
        <div className="board-cards">{[{ label: "Flop", indices: [0, 1, 2] }, { label: "Turn", indices: [3] }, { label: "River", indices: [4] }].map(group => <div className={`board-street-group ${group.indices.every(i => !!board[i]) ? "is-dealt" : ""}`} key={group.label} aria-label={`${group.label} cards`}>
          <div className="board-street-cards">{group.indices.map(i => <PlayingCard key={i} card={board[i]} winning={winningCards.includes(board[i])} ghost />)}</div>
          <span className="board-street-label">{group.label}</span>
        </div>)}</div>
        <div className="board-pot"><span>Pot</span><Layers3 size={13} aria-hidden="true" /><strong>{pot.toLocaleString()}</strong><span>chips</span></div>
      </div>
    </div>
    <div className="seats-grid">{seats.map((seat, i) => {
      const state = seat.winner ? "Winner" : seat.folded ? "Folded" : seat.allIn ? "All-in" : seat.active && !settled ? "Turn" : null;
      return <article className={`player-seat seat-${i} ${seat.active && !settled ? "seat-active" : ""} ${seat.folded ? "seat-folded" : ""} ${seat.winner ? "seat-winner" : ""} ${seat.allIn ? "seat-all-in" : ""}`} key={seat.id} aria-label={`${seat.name}${state ? `, ${state.toLowerCase()}` : ""}`}>
        <div className="seat-identity"><ModelMark name={seat.name} /><div><h3>{seat.name}{seat.dealer ? <span className="dealer-button" title="Dealer" aria-label="Dealer">D</span> : null}</h3><span>{started ? `${seat.stack.toLocaleString()} chips` : "Decision model"}</span></div>{state ? <span className="seat-state">{state}</span> : null}</div>
        <div className="seat-hand"><PlayingCard card={seat.cards[0]} winning={seat.winner && winningCards.includes(seat.cards[0])} small /><PlayingCard card={seat.cards[1]} winning={seat.winner && winningCards.includes(seat.cards[1])} small /><span className="seat-action">{seat.winner ? "Paid out" : seat.folded ? "Out of this hand" : seat.active && busy ? "Deciding…" : seat.action}</span></div>
        <PlayerClass name={started ? seat.className : undefined} description={seat.description} />
      </article>;
    })}</div>
  </section>;
}
