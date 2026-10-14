import { Eye, Layers3 } from "lucide-react";
import { PlayingCard } from "./PlayingCard";

export type TableSeat = {
  id: string; name: string; cards: string[]; stack: number; action: string;
  folded: boolean; active: boolean; dealer: boolean; winner: boolean; description: string;
};

export const MODEL_SEATS: TableSeat[] = [
  { id: "gpt", name: "GPT", cards: [], stack: 1000, action: "Ready to play", folded: false, active: false, dealer: false, winner: false, description: "Patient. Selective. Picks its moment." },
  { id: "claude", name: "Claude", cards: [], stack: 1000, action: "Ready to play", folded: false, active: false, dealer: false, winner: false, description: "Measured pressure. Comfortable bluffing." },
  { id: "gemini", name: "Gemini", cards: [], stack: 1000, action: "Ready to play", folded: false, active: false, dealer: false, winner: false, description: "Curious. Competitive. Hard to shake." },
  { id: "grok", name: "Grok", cards: [], stack: 1000, action: "Ready to play", folded: false, active: false, dealer: false, winner: false, description: "Unpredictable. Makes you think twice." },
];

export function ModelMark({ name }: { name: string }) {
  const lower = name.toLowerCase();
  return <span aria-hidden="true" className={`model-mark model-${lower.includes("gpt") ? "gpt" : lower.includes("claude") ? "claude" : lower.includes("gemini") ? "gemini" : "grok"}`}>{lower.includes("claude") ? "✳" : lower.includes("gemini") ? "✦" : lower.includes("gpt") ? "◎" : "╱"}</span>;
}

export function PokerTable({ seats, board, pot, street, started, busy, settled, winningCards = [] }: {
  seats: TableSeat[]; board: string[]; pot: number; street: string; started: boolean; busy: boolean; settled: boolean; winningCards?: string[];
}) {
  return <section className="table-panel" aria-label="Poker table with all dealt hands visible">
    <div className="table-corner-label"><span className={`status-dot ${started && !settled ? "status-dot-live" : ""}`} />{!started ? "TABLE READY" : settled ? "HAND SETTLED" : "TABLE IN PLAY"}</div>
    <div className="table-observer"><Eye size={13} /> Spectator view</div>
    <div className="poker-felt"><div className="felt-inner" />
      <div className="board-area">
        <div className="pot-label">{started ? "TOTAL POT" : "FOUR MINDS. ONE TABLE."}</div>
        <div className="pot-value">{started ? <><Layers3 size={18} />{pot.toLocaleString()} <small>chips</small></> : <span className="table-wordmark">River Market</span>}</div>
        <div className="board-cards">{Array.from({ length: 5 }, (_, i) => <PlayingCard key={i} card={board[i]} winning={winningCards.includes(board[i])} ghost />)}</div>
        <span className="street-label">{!started ? "NO-LIMIT TEXAS HOLD’EM" : busy ? "Models are deciding…" : street.replaceAll("_", " ")}</span>
      </div>
    </div>
    <div className="seats-grid">{seats.map((seat, i) => <article className={`player-seat seat-${i} ${seat.active ? "seat-active" : ""} ${seat.folded ? "seat-folded" : ""} ${seat.winner ? "seat-winner" : ""}`} key={seat.id} aria-label={`${seat.name}${seat.active ? ", acting now" : ""}${seat.folded ? ", folded" : ""}`}>
      <div className="seat-identity"><ModelMark name={seat.name} /><div><h3>{seat.name}</h3><span>{started ? `${seat.stack.toLocaleString()} chips` : "Decision model"}</span></div>{seat.dealer ? <span className="dealer-button" title="Dealer">D</span> : null}</div>
      <div className="seat-hand"><PlayingCard card={seat.cards[0]} winning={seat.winner && winningCards.includes(seat.cards[0])} small /><PlayingCard card={seat.cards[1]} winning={seat.winner && winningCards.includes(seat.cards[1])} small /><span className={`seat-action ${seat.winner ? "winning-action" : ""}`}>{seat.winner ? "Winner" : seat.folded ? "Folded" : seat.action}</span></div>
      <p className="seat-description" title={seat.description}>{seat.description}</p>
    </article>)}</div>
    <div className="table-bottom-note"><span className="tiny-diamond">◇</span> You see every hand. The models only see their own.</div>
  </section>;
}
