const suits: Record<string, { symbol: string; name: string }> = {
  s: { symbol: "♠", name: "spades" }, h: { symbol: "♥", name: "hearts" },
  d: { symbol: "♦", name: "diamonds" }, c: { symbol: "♣", name: "clubs" },
};
const ranks: Record<string, string> = { A: "Ace", K: "King", Q: "Queen", J: "Jack", T: "Ten" };

export function PlayingCard({ card, small = false, ghost = false, winning = false }: { card?: string; small?: boolean; ghost?: boolean; winning?: boolean }) {
  if (!card) return <div role="img" aria-label={ghost ? "Community card not dealt" : "Card not dealt"} className={`playing-card card-back ${small ? "card-small" : ""} ${ghost ? "card-ghost" : ""}`} />;
  const suit = suits[card.slice(-1).toLowerCase()] ?? suits.s;
  const value = card.slice(0, -1).toUpperCase();
  const rank = value === "T" ? "10" : value;
  return <div role="img" aria-label={`${ranks[value] ?? rank} of ${suit.name}${winning ? ", part of the winning hand" : ""}`} className={`playing-card suit-${card.slice(-1).toLowerCase()} ${small ? "card-small" : ""} ${winning ? "card-winning" : ""}`}>
    <span className="card-corner" aria-hidden="true"><b>{rank}</b><span>{suit.symbol}</span></span>
    <span className="card-pip" aria-hidden="true">{suit.symbol}</span>
    <span className="card-corner card-corner-bottom" aria-hidden="true"><b>{rank}</b><span>{suit.symbol}</span></span>
  </div>;
}
