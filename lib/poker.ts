/** Server-authoritative four-seat no-limit Hold'em. Amounts are integer chips.
 * No model callback ever receives PokerState: use getObservation exclusively.
 * Production seeds must be secret 64-character hex strings, not numeric seeds.
 */
export type Card = string;
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';
export type Action = { type: 'fold' | 'check' | 'call' | 'raise'; amount?: number };
export type LegalActions = {
  canFold: boolean; canCheck: boolean; canCall: boolean; canRaise: boolean;
  callAmount: number; minRaiseTo: number | null; maxRaiseTo: number;
};
export type Player = {
  seat: number; name: string; stack: number; hole: Card[]; folded: boolean;
  allIn: boolean; bet: number; contributed: number; lastAction: string;
};
export type PublicPlayer = Omit<Player, 'hole'>;
export type PokerEvent = {
  id: number; street: Street; seat: number | null; type: string;
  amount?: number; cards?: Card[]; pot: number; text: string;
};
export type Pot = { amount: number; eligible: number[]; winners: number[] };
export type PokerState = {
  seed: number | string; deck: Card[]; button: number; smallBlind: number; bigBlind: number;
  street: Street; board: Card[]; players: Player[]; actor: number | null;
  pot: number; currentBet: number; minRaise: number; pending: number[];
  actedAt: number[]; history: PokerEvent[]; winners: number[]; payouts: number[];
  mainPotWinners: number[]; mainPotShares: number[]; pots: Pot[]; revision: number;
};
export type Style = { id: string; name: string; description: string };
export const STYLES: readonly Style[] = [
  { id: 'disciplined', name: 'The Analyst', description: 'Selective before the flop. Values position, strong draws, and measured bets.' },
  { id: 'pressure', name: 'The Challenger', description: 'Applies pressure with a wider range. Will bluff when opponents show weakness.' },
  { id: 'patient', name: 'The Sentinel', description: 'Patient and selective. Tends to protect chips, then commits with conviction.' },
  { id: 'unpredictable', name: 'The Wildcard', description: 'Plays a wide range with varied sizing. Mixes bold bluffs with unexpected slow plays.' },
];
export const STYLE = STYLES;
export const PROVIDERS = ['GPT', 'Claude', 'Gemini', 'Grok'] as const;
export type Observation = {
  seat: number; name: string; hole: Card[]; board: Card[]; street: Street;
  button: number; smallBlind: number; bigBlind: number; pot: number; currentBet: number;
  players: PublicPlayer[]; legal: LegalActions; history: PokerEvent[];
  style: Style; revision: number;
};
export type SpectatorState = Omit<PokerState, 'seed' | 'deck' | 'actedAt' | 'pending'>;

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
export const fullDeck = (): Card[] => [...SUITS].flatMap(suit => [...RANKS].map(rank => rank + suit));
const seatOrder = (after: number) => [1, 2, 3, 4].map(n => (after + n) % 4);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** ChaCha20 stream, fixed nonce for a unique secret seed/key per hand. Numeric
 * seeds exist for reproducible tests only; they are not secure game seeds. */
function randomStream(seed: number | string): () => number {
  const hex = typeof seed === 'string' && /^[a-f\d]{64}$/i.test(seed) ? seed : null;
  const key = new Uint32Array(8);
  if (hex) {
    for (let i = 0; i < 8; i++) {
      const offset = i * 8;
      key[i] = (parseInt(hex.slice(offset, offset + 2), 16)
        | parseInt(hex.slice(offset + 2, offset + 4), 16) << 8
        | parseInt(hex.slice(offset + 4, offset + 6), 16) << 16
        | parseInt(hex.slice(offset + 6, offset + 8), 16) << 24) >>> 0;
    }
  } else {
    let value = 2166136261;
    for (const char of String(seed)) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
    for (let i = 0; i < 8; i++) {
      value = (value + 0x9e3779b9) >>> 0;
      let z = value;
      z = Math.imul(z ^ z >>> 16, 0x21f0aaad);
      z = Math.imul(z ^ z >>> 15, 0x735a2d97);
      key[i] = (z ^ z >>> 15) >>> 0;
    }
  }
  const base = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, 0, 0, 0, 0]);
  let block = new Uint32Array(16), cursor = 16;
  const rot = (x: number, n: number) => (x << n | x >>> (32 - n)) >>> 0;
  const quarter = (x: Uint32Array, a: number, b: number, c: number, d: number) => {
    x[a] = x[a] + x[b]; x[d] = rot(x[d] ^ x[a], 16);
    x[c] = x[c] + x[d]; x[b] = rot(x[b] ^ x[c], 12);
    x[a] = x[a] + x[b]; x[d] = rot(x[d] ^ x[a], 8);
    x[c] = x[c] + x[d]; x[b] = rot(x[b] ^ x[c], 7);
  };
  return () => {
    if (cursor === 16) {
      block = new Uint32Array(base);
      for (let round = 0; round < 10; round++) {
        quarter(block, 0, 4, 8, 12); quarter(block, 1, 5, 9, 13);
        quarter(block, 2, 6, 10, 14); quarter(block, 3, 7, 11, 15);
        quarter(block, 0, 5, 10, 15); quarter(block, 1, 6, 11, 12);
        quarter(block, 2, 7, 8, 13); quarter(block, 3, 4, 9, 14);
      }
      for (let i = 0; i < 16; i++) block[i] = block[i] + base[i];
      base[12]++; if (base[12] === 0) base[13]++;
      cursor = 0;
    }
    return block[cursor++];
  };
}
export function shuffledDeck(seed: number | string, cards: Card[] = fullDeck()): Card[] {
  const deck = [...cards], random = randomStream(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const size = i + 1, limit = Math.floor(4294967296 / size) * size;
    let draw = random(); while (draw >= limit) draw = random();
    const j = draw % size; [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Direct 5–7 card rank, category followed by five base-15 tiebreak digits. */
export function evaluate(cards: readonly Card[]): number {
  const count = new Int8Array(15), suits: number[][] = [[], [], [], []];
  for (const card of cards) {
    const rank = RANKS.indexOf(card[0]) + 2, suit = SUITS.indexOf(card[1]);
    if (rank < 2 || suit < 0 || card.length !== 2) throw new Error('Invalid card');
    count[rank]++; suits[suit].push(rank);
  }
  const descending: number[] = [], pairs: number[] = [], trips: number[] = [], quads: number[] = [];
  for (let rank = 14; rank >= 2; rank--) {
    if (count[rank]) descending.push(rank);
    if (count[rank] >= 2) pairs.push(rank);
    if (count[rank] >= 3) trips.push(rank);
    if (count[rank] === 4) quads.push(rank);
  }
  const straight = (ranks: number[]) => {
    const available = new Set(ranks); if (available.has(14)) available.add(1);
    for (let high = 14; high >= 5; high--) {
      if ([0, 1, 2, 3, 4].every(delta => available.has(high - delta))) return high;
    }
    return 0;
  };
  const pack = (category: number, kickers: number[]) => {
    let value = category;
    for (let i = 0; i < 5; i++) value = value * 15 + (kickers[i] ?? 0);
    return value;
  };
  const flush = suits.find(ranks => ranks.length >= 5)?.sort((a, b) => b - a);
  const straightFlush = flush ? straight(flush) : 0;
  if (straightFlush) return pack(8, [straightFlush]);
  if (quads.length) return pack(7, [quads[0], ...descending.filter(r => r !== quads[0]).slice(0, 1)]);
  if (trips.length && pairs.some(r => r !== trips[0])) return pack(6, [trips[0], pairs.find(r => r !== trips[0])!]);
  if (flush) return pack(5, flush.slice(0, 5));
  const run = straight(descending); if (run) return pack(4, [run]);
  if (trips.length) return pack(3, [trips[0], ...descending.filter(r => r !== trips[0]).slice(0, 2)]);
  if (pairs.length >= 2) return pack(2, [pairs[0], pairs[1], ...descending.filter(r => !pairs.slice(0, 2).includes(r)).slice(0, 1)]);
  if (pairs.length) return pack(1, [pairs[0], ...descending.filter(r => r !== pairs[0]).slice(0, 3)]);
  return pack(0, descending.slice(0, 5));
}
const HAND_NAMES = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
export function evaluateHand(cards: readonly Card[]): { rank: number; category: number; name: string; cards: Card[] } {
  const rank = evaluate(cards), category = Math.floor(rank / 15 ** 5);
  let best: Card[] = [...cards];
  if (cards.length > 5) {
    outer: for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++)
        for (let e = d + 1; e < cards.length; e++) {
          const candidate = [cards[a], cards[b], cards[c], cards[d], cards[e]];
          if (evaluate(candidate) === rank) { best = candidate; break outer; }
        }
  }
  return { rank, category, name: HAND_NAMES[category], cards: best };
}

function event(state: PokerState, data: Omit<PokerEvent, 'id' | 'street' | 'pot'>): void {
  state.history.push({ id: state.history.length + 1, street: state.street, pot: state.pot, ...data });
}
function pay(state: PokerState, seat: number, amount: number): void {
  const player = state.players[seat];
  player.stack -= amount; player.bet += amount; player.contributed += amount;
  player.allIn = player.stack === 0; state.pot += amount;
}
export function createHand(seed: number | string, button: number, startingStack = 1000): PokerState {
  if (!Number.isSafeInteger(startingStack) || startingStack < 10) throw new Error('Starting stack must be an integer of at least 10');
  if (!Number.isInteger(button) || button < 0 || button > 3) throw new Error('Button must be a seat from 0 to 3');
  const deck = shuffledDeck(seed);
  const players: Player[] = PROVIDERS.map((name, seat) => ({ seat, name, stack: startingStack, hole: [], folded: false, allIn: false, bet: 0, contributed: 0, lastAction: '' }));
  for (let round = 0; round < 2; round++) for (const seat of seatOrder(button)) players[seat].hole.push(deck.pop()!);
  const state: PokerState = {
    seed, deck, button, smallBlind: 5, bigBlind: 10, street: 'preflop', board: [], players,
    actor: null, pot: 0, currentBet: 10, minRaise: 10, pending: [], actedAt: [-1, -1, -1, -1],
    history: [], winners: [], payouts: [0, 0, 0, 0], mainPotWinners: [], mainPotShares: [0, 0, 0, 0], pots: [], revision: 0,
  };
  const small = (button + 1) % 4, big = (button + 2) % 4;
  pay(state, small, 5); players[small].lastAction = 'Small blind';
  event(state, { type: 'blind', seat: small, amount: 5, text: `${players[small].name} posts 5` });
  pay(state, big, 10); players[big].lastAction = 'Big blind';
  event(state, { type: 'blind', seat: big, amount: 10, text: `${players[big].name} posts 10` });
  state.pending = seatOrder(big).filter(seat => !players[seat].allIn);
  state.actor = state.pending[0] ?? null;
  return state;
}

export function legalActions(state: PokerState): LegalActions {
  const empty: LegalActions = { canFold: false, canCheck: false, canCall: false, canRaise: false, callAmount: 0, minRaiseTo: null, maxRaiseTo: 0 };
  if (state.actor === null || state.street === 'complete') return empty;
  const player = state.players[state.actor], owed = Math.max(0, state.currentBet - player.bet);
  const maxRaiseTo = player.bet + player.stack;
  // A check is not a wager: a later short opening all-in still allows a raise.
  const reopened = state.actedAt[player.seat] <= 0 || state.currentBet - state.actedAt[player.seat] >= state.minRaise;
  const opponentCanRespond = state.players.some(p => p.seat !== player.seat && !p.folded && p.bet + p.stack > state.currentBet);
  const canRaise = reopened && opponentCanRespond && maxRaiseTo > state.currentBet;
  return {
    canFold: owed > 0, canCheck: owed === 0, canCall: owed > 0,
    callAmount: Math.min(owed, player.stack), canRaise, maxRaiseTo,
    minRaiseTo: canRaise ? Math.min(state.currentBet + state.minRaise, maxRaiseTo) : null,
  };
}

function refundUncalled(state: PokerState): void {
  const ordered = [...state.players].sort((a, b) => b.bet - a.bet);
  const excess = ordered[0].bet - ordered[1].bet;
  if (excess <= 0) return;
  const player = state.players[ordered[0].seat];
  player.bet -= excess; player.contributed -= excess; player.stack += excess;
  player.allIn = player.stack === 0; state.pot -= excess;
  event(state, { type: 'refund', seat: player.seat, amount: excess, text: `${player.name} receives ${excess} uncalled chips` });
}

function settle(state: PokerState): void {
  refundUncalled(state);
  const live = state.players.filter(player => !player.folded);
  const ranks = state.players.map(player => player.folded ? -1 : evaluate([...player.hole, ...state.board]));
  const levels = [...new Set(state.players.map(player => player.contributed).filter(amount => amount > 0))].sort((a, b) => a - b);
  const payouts = [0, 0, 0, 0], pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = state.players.filter(player => player.contributed >= level);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter(player => !player.folded).map(player => player.seat);
    if (eligible.length === 0) throw new Error('Pot has no eligible player');
    const best = Math.max(...eligible.map(seat => ranks[seat]));
    const winners = live.length === 1 ? [live[0].seat] : eligible.filter(seat => ranks[seat] === best);
    const share = Math.floor(amount / winners.length), odd = amount % winners.length;
    for (const seat of winners) payouts[seat] += share;
    const oddOrder = seatOrder(state.button).filter(seat => winners.includes(seat));
    for (let i = 0; i < odd; i++) payouts[oddOrder[i]]++;
    pots.push({ amount, eligible, winners }); previous = level;
  }
  state.pots = pots; state.payouts = payouts;
  state.mainPotWinners = pots[0]?.winners ?? [];
  state.mainPotShares = state.players.map(player => state.mainPotWinners.includes(player.seat) ? 1 / state.mainPotWinners.length : 0);
  state.winners = state.players.filter(player => payouts[player.seat] > 0).map(player => player.seat);
  for (const player of state.players) { player.stack += payouts[player.seat]; player.allIn = false; }
  state.street = 'complete'; state.actor = null; state.pending = [];
  event(state, { type: 'settlement', seat: null, text: `${state.mainPotWinners.map(seat => state.players[seat].name).join(' & ')} ${state.mainPotWinners.length === 1 ? 'wins' : 'split'} the main pot` });
}

function nextStreet(state: PokerState): void {
  const next: Record<string, Street> = { preflop: 'flop', flop: 'turn', turn: 'river' };
  if (state.street === 'river') { settle(state); return; }
  state.street = next[state.street];
  state.deck.pop(); // burn: never exposed in either public projection
  const cards = Array.from({ length: state.street === 'flop' ? 3 : 1 }, () => state.deck.pop()!);
  if (cards.some(card => !card)) throw new Error('Deck exhausted');
  state.board.push(...cards);
  for (const player of state.players) player.bet = 0;
  state.currentBet = 0; state.minRaise = state.bigBlind; state.actedAt = [-1, -1, -1, -1];
  state.pending = seatOrder(state.button).filter(seat => !state.players[seat].folded && !state.players[seat].allIn);
  state.actor = state.pending[0] ?? null;
  event(state, { type: 'board', seat: null, cards, text: `${state.street[0].toUpperCase() + state.street.slice(1)}: ${cards.join(' ')}` });
}

function advance(state: PokerState): void {
  state.pending = state.pending.filter(seat => !state.players[seat].folded && !state.players[seat].allIn);
  const active = state.players.filter(player => !player.folded);
  if (active.length === 1) { settle(state); return; }
  if (state.pending.length > 0) { state.actor = state.pending[0]; return; }
  refundUncalled(state);
  if (active.filter(player => !player.allIn).length <= 1) {
    while (state.street !== 'river' && state.street !== 'complete') nextStreet(state);
    if (state.street !== 'complete') settle(state);
    return;
  }
  nextStreet(state);
}

/** Returns a new state; invalid actions throw without modifying the input. */
export function applyAction(original: PokerState, action: Action): PokerState {
  if (original.actor === null || original.street === 'complete') throw new Error('Hand has no active decision');
  const legal = legalActions(original);
  if (!action || !['fold', 'check', 'call', 'raise'].includes(action.type)) throw new Error('Invalid action');
  if (action.type === 'fold' && !legal.canFold) throw new Error('Cannot fold when checking is available');
  if (action.type === 'check' && !legal.canCheck) throw new Error('Cannot check facing a bet');
  if (action.type === 'call' && !legal.canCall) throw new Error('No bet to call');
  if (action.type === 'raise' && (!legal.canRaise || !Number.isSafeInteger(action.amount)
    || action.amount! < legal.minRaiseTo! || action.amount! > legal.maxRaiseTo)) throw new Error('Illegal raise amount or action not reopened');
  if (action.type !== 'raise' && action.amount !== undefined) throw new Error('Only raises take an amount');
  const state = clone(original), seat = state.actor!, player = state.players[seat];
  state.pending = state.pending.filter(index => index !== seat);
  let amount: number | undefined;
  if (action.type === 'fold') player.folded = true;
  if (action.type === 'call') { amount = legal.callAmount; pay(state, seat, amount); }
  if (action.type === 'raise') {
    amount = action.amount!;
    const increment = amount - state.currentBet;
    pay(state, seat, amount - player.bet);
    if (increment >= state.minRaise) state.minRaise = increment;
    state.currentBet = amount;
    state.pending = seatOrder(seat).filter(index => index !== seat && !state.players[index].folded && !state.players[index].allIn);
  }
  state.actedAt[seat] = state.currentBet;
  player.lastAction = action.type === 'raise' ? `${player.allIn ? 'All-in' : 'Raise'} to ${amount}`
    : action.type === 'call' ? `${player.allIn ? 'All-in call' : 'Call'} ${amount}`
    : action.type[0].toUpperCase() + action.type.slice(1);
  event(state, { seat, type: action.type, ...(amount !== undefined ? { amount } : {}), text: `${player.name}: ${player.lastAction}` });
  state.revision++;
  advance(state);
  return state;
}

export function getObservation(state: PokerState, seat: number): Observation {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new Error('Invalid seat');
  const player = state.players[seat];
  // Explicit allowlist, including public player fields. Never spread PokerState.
  return clone({
    seat, name: player.name, hole: player.hole, board: state.board, street: state.street,
    button: state.button, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
    pot: state.pot, currentBet: state.currentBet, revision: state.revision,
    players: state.players.map(p => ({ seat: p.seat, name: p.name, stack: p.stack,
      folded: p.folded, allIn: p.allIn, bet: p.bet, contributed: p.contributed, lastAction: p.lastAction })),
    legal: state.actor === seat ? legalActions(state) : { canFold: false, canCheck: false, canCall: false, canRaise: false, callAmount: 0, minRaiseTo: null, maxRaiseTo: 0 },
    history: state.history, style: STYLES[seat],
  });
}
export function getSpectator(state: PokerState): SpectatorState {
  return clone({
    button: state.button, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
    street: state.street, board: state.board, players: state.players, actor: state.actor,
    pot: state.pot, currentBet: state.currentBet, minRaise: state.minRaise,
    history: state.history, winners: state.winners, payouts: state.payouts,
    mainPotWinners: state.mainPotWinners, mainPotShares: state.mainPotShares,
    pots: state.pots, revision: state.revision,
  });
}

// Numeric style parameters are server-private, not part of spectator/agent DTOs.
const POLICIES = [
  { loose: 0.00, aggression: 0.52, bluff: 0.07, sizing: 0.60 },
  { loose: 0.11, aggression: 0.72, bluff: 0.19, sizing: 0.85 },
  { loose: -0.07, aggression: 0.40, bluff: 0.03, sizing: 0.65 },
  { loose: 0.16, aggression: 0.62, bluff: 0.25, sizing: 1.00 },
];
function strength(observation: Observation): number {
  const [first, second] = observation.hole;
  const a = RANKS.indexOf(first[0]) + 2, b = RANKS.indexOf(second[0]) + 2;
  if (observation.board.length === 0) {
    return Math.min(0.97, Math.max(0.06, 0.13 + (a + b - 4) / 48
      + (a === b ? 0.22 + a / 100 : 0) + (first[1] === second[1] ? 0.05 : 0)
      + (Math.abs(a - b) === 1 ? 0.035 : 0) - (Math.abs(a - b) > 5 ? 0.07 : 0)));
  }
  const cards = [...observation.hole, ...observation.board];
  const category = Math.floor(evaluate(cards) / 15 ** 5);
  const boardCategory = Math.floor(evaluate(observation.board) / 15 ** 5);
  let value = [0.18, 0.48, 0.67, 0.79, 0.86, 0.91, 0.96, 0.99, 0.999][category];
  if (category <= boardCategory) value -= category > 0 ? 0.28 : 0;
  if (category === 1) {
    const boardRanks = observation.board.map(card => RANKS.indexOf(card[0]) + 2);
    const paired = [a, b].filter(rank => a === b || boardRanks.includes(rank));
    if (paired.length && Math.max(...paired) >= Math.max(...boardRanks)) value += 0.12;
  }
  if (observation.board.length < 5) {
    const fourFlush = [...SUITS].some(suit => cards.filter(card => card[1] === suit).length === 4 && observation.hole.some(card => card[1] === suit));
    if (fourFlush) value += 0.12;
    const ranks = new Set(cards.map(card => RANKS.indexOf(card[0]) + 2));
    if (ranks.has(14)) ranks.add(1);
    if (Array.from({ length: 10 }, (_, i) => i + 5).some(high => [0, 1, 2, 3, 4].filter(delta => ranks.has(high - delta)).length === 4)) value += 0.07;
  }
  return Math.min(0.999, Math.max(0.03, value));
}
/** Deterministic, imperfect-information practice policy. This function receives
 * only an Observation, so it cannot peek at opponents' cards or the runout. */
export function decidePractice(observation: Observation, seed: number): Action {
  const random = randomStream(seed), roll = () => random() / 4294967296;
  const legal = observation.legal, policy = POLICIES[observation.seat];
  const own = observation.players[observation.seat];
  const live = observation.players.filter(player => !player.folded).length;
  const value = strength(observation) + policy.loose - Math.max(0, live - 2) * 0.035;
  const price = legal.callAmount / Math.max(1, observation.pot + legal.callAmount);
  const commitment = legal.callAmount / Math.max(1, own.stack);
  const bluff = roll() < policy.bluff / Math.max(1, live - 1);
  const shouldRaise = (value > 0.67 && roll() < policy.aggression) || (bluff && commitment < 0.18);
  if (legal.canRaise && shouldRaise) {
    const desired = observation.currentBet + Math.max(observation.bigBlind, Math.round((observation.pot + legal.callAmount) * policy.sizing * (0.7 + roll() * 0.6)));
    return { type: 'raise', amount: Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo!, desired)) };
  }
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall && (value > 0.20 + price * 0.7 + commitment * 0.26 || bluff || (legal.callAmount <= observation.bigBlind && value > 0.29))) return { type: 'call' };
  if (legal.canFold) return { type: 'fold' };
  throw new Error('Practice policy has no legal action');
}

/** Expected MAIN-POT contract payout conditional on the spectator's known
 * hole cards, using practice policies as future-action surrogates. This is NOT
 * a public-information market prior and is not a calibrated LLM forecast. */
export function estimateValues(state: PokerState, seed: number, samples = 96): number[] {
  if (state.street === 'complete') return [...state.mainPotShares];
  if (!Number.isFinite(samples)) throw new Error('Sample count must be finite');
  const n = Math.min(8192, Math.max(1, Math.floor(samples)));
  const values = [0, 0, 0, 0], known = new Set([...state.board, ...state.players.flatMap(player => player.hole)]);
  const unknown = fullDeck().filter(card => !known.has(card));
  const random = randomStream(seed);
  for (let iteration = 0; iteration < n; iteration++) {
    let rollout = clone(state);
    rollout.deck = shuffledDeck(random(), unknown);
    rollout.history = []; // histories are not read by the deterministic surrogate
    let steps = 0;
    while (rollout.street !== 'complete' && steps++ < 160) {
      if (rollout.actor === null) { advance(rollout); continue; }
      rollout = applyAction(rollout, decidePractice(getObservation(rollout, rollout.actor), random()));
      rollout.history = [];
    }
    if (rollout.street !== 'complete') {
      // Budget guard: force legal check/call actions; no invented outcome.
      while (rollout.street !== 'complete') rollout = applyAction(rollout, { type: legalActions(rollout).canCheck ? 'check' : 'call' });
    }
    for (let seat = 0; seat < 4; seat++) values[seat] += rollout.mainPotShares[seat];
  }
  // A finite rollout sample of zero is not proof that a live outcome is
  // impossible. Jeffreys smoothing preserves every live outcome while folded
  // seats retain exact zero. Terminal payouts above are never smoothed.
  const eligible = state.players.filter(player => !player.folded).length;
  return values.map((value, seat) => state.players[seat].folded ? 0 : (value + 0.5) / (n + eligible * 0.5));
}
