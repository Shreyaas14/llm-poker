import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createHand, applyAction, legalActions, getObservation, getSpectator, decidePractice, estimateValues, evaluate, evaluateHand, fullDeck, shuffledDeck, type PokerState, type Action } from '../lib/poker.ts';

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const total = (state: PokerState) => state.players.reduce((n, p) => n + p.stack, 0) + (state.street === 'complete' ? 0 : state.pot);
const call = (state: PokerState) => applyAction(state, { type: legalActions(state).canCheck ? 'check' : 'call' });
function toFlop(): PokerState {
  let state = createHand(1, 0);
  while (state.street === 'preflop') state = call(state);
  return state;
}
function toEnd(state: PokerState): PokerState {
  let actions = 0;
  while (state.street !== 'complete') {
    assert.ok(++actions < 100);
    state = call(state);
  }
  return state;
}

test('deck is complete, deterministic and sensitive to a full secret seed', () => {
  const seed = '0123456789abcdef'.repeat(4);
  assert.equal(new Set(shuffledDeck(seed)).size, 52);
  assert.deepEqual(shuffledDeck(seed), shuffledDeck(seed));
  assert.notDeepEqual(shuffledDeck(seed), shuffledDeck('0'.repeat(64)));
  assert.notDeepEqual(shuffledDeck(1), shuffledDeck(2));
});

test('secret-seed shuffle matches the independent native ChaCha20 stream', () => {
  const cipher = createCipheriv('chacha20', Buffer.alloc(32), Buffer.alloc(16));
  const stream = cipher.update(Buffer.alloc(1024));
  const expected = fullDeck(); let offset = 0;
  const read = () => { const value = stream.readUInt32LE(offset); offset += 4; return value; };
  for (let i = expected.length - 1; i > 0; i--) {
    const size = i + 1, limit = Math.floor(4294967296 / size) * size;
    let value = read(); while (value >= limit) value = read();
    const j = value % size; [expected[i], expected[j]] = [expected[j], expected[i]];
  }
  assert.deepEqual(shuffledDeck('0'.repeat(64)), expected);
});

test('blinds, preflop action order, big-blind option, postflop order', () => {
  let state = createHand(10, 0);
  assert.equal(state.actor, 3);
  assert.equal(state.players[1].bet, 5);
  assert.equal(state.players[2].bet, 10);
  assert.equal(state.pot, 15);
  state = call(state); assert.equal(state.actor, 0);
  state = call(state); assert.equal(state.actor, 1);
  state = call(state); assert.equal(state.actor, 2);
  assert.equal(legalActions(state).canCheck, true);
  assert.equal(legalActions(state).canRaise, true);
  state = call(state);
  assert.equal(state.street, 'flop'); assert.equal(state.actor, 1);
  assert.equal(state.board.length, 3); assert.equal(state.pot, 40);
  assert.equal(state.currentBet, 0);
});

test('full raise uses the previous increment, and invalid actions are atomic', () => {
  let state = createHand(2, 0);
  const original = copy(state);
  assert.throws(() => applyAction(state, { type: 'check' }));
  assert.throws(() => applyAction(state, { type: 'raise', amount: 19 }));
  assert.throws(() => applyAction(state, { type: 'raise', amount: 1001 }));
  assert.throws(() => applyAction(state, { type: 'raise', amount: 20.5 }));
  assert.deepEqual(state, original);
  state = applyAction(state, { type: 'raise', amount: 30 });
  assert.equal(legalActions(state).minRaiseTo, 50);
  state = applyAction(state, { type: 'raise', amount: 70 });
  assert.equal(legalActions(state).minRaiseTo, 110);
});

test('short all-in does not reopen a previous bettor', () => {
  let state = createHand(3, 0);
  state.players[0].stack = 150;
  state = applyAction(state, { type: 'raise', amount: 100 }); // seat 3, full increment 90
  state = applyAction(state, { type: 'raise', amount: 150 }); // seat 0, short all-in
  state = call(state); // seat 1
  state = call(state); // seat 2
  assert.equal(state.actor, 3);
  assert.equal(legalActions(state).canRaise, false);
  assert.equal(legalActions(state).callAmount, 50);
  assert.throws(() => applyAction(state, { type: 'raise', amount: 250 }));
  state = call(state); assert.equal(state.street, 'flop');
});

test('cumulative short all-ins reopen only actors facing a full increment', () => {
  let state = createHand(4, 0);
  state.players[0].stack = 150;
  state.players[1].stack = 195; // 200 total including small blind
  state = applyAction(state, { type: 'raise', amount: 100 });
  state = applyAction(state, { type: 'raise', amount: 150 });
  state = applyAction(state, { type: 'raise', amount: 200 });
  state = call(state);
  assert.equal(state.actor, 3);
  assert.equal(legalActions(state).canRaise, true);
  assert.equal(legalActions(state).minRaiseTo, 290);
});

test('a caller of the first short raise cannot reraise the second short raise', () => {
  let state = createHand(5, 0);
  state.players[0].stack = 150;
  state.players[2].stack = 190; // 200 total
  state = applyAction(state, { type: 'raise', amount: 100 });
  state = applyAction(state, { type: 'raise', amount: 150 });
  state = call(state); // seat 1 acted at 150
  state = applyAction(state, { type: 'raise', amount: 200 });
  state = call(state); // seat 3 acted at 200
  assert.equal(state.actor, 1);
  assert.equal(legalActions(state).canRaise, false);
});

test('a prior check allows raising a short opening all-in', () => {
  let state = toFlop();
  state.players[2].stack = 5;
  state = applyAction(state, { type: 'check' }); // seat 1
  state = applyAction(state, { type: 'raise', amount: 5 }); // seat 2 all-in
  state = call(state); state = call(state);
  assert.equal(state.actor, 1);
  assert.equal(legalActions(state).canRaise, true);
  assert.equal(legalActions(state).minRaiseTo, 15);
});

test('fold win returns uncalled excess and conserves chips', () => {
  let state = createHand(6, 0);
  state = applyAction(state, { type: 'raise', amount: 100 });
  state = applyAction(state, { type: 'fold' });
  state = applyAction(state, { type: 'fold' });
  state = applyAction(state, { type: 'fold' });
  assert.equal(state.street, 'complete');
  assert.deepEqual(state.mainPotShares, [0, 0, 0, 1]);
  assert.equal(state.pot, 25);
  assert.equal(state.players[3].stack, 1015);
  assert.equal(total(state), 4000);
  assert.equal(state.board.length, 0);
  assert.ok(state.history.some(e => e.type === 'refund' && e.amount === 90));
});

function riverFixture(): PokerState {
  const state = createHand(7, 0);
  state.street = 'river'; state.board = ['2c', '3d', '7h', '9s', 'Jc'];
  const holes = [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh'], ['Ts', 'Th']];
  for (let i = 0; i < 4; i++) {
    state.players[i].hole = holes[i]; state.players[i].stack = 0;
    state.players[i].bet = 0; state.players[i].contributed = 0;
    state.players[i].allIn = true; state.players[i].folded = false;
  }
  state.currentBet = 0; state.minRaise = 10; state.actedAt = [-1, -1, -1, -1];
  state.pending = [3]; state.actor = 3; state.players[3].allIn = false;
  state.players[3].stack = 1; state.history = [];
  state.deck = fullDeck().filter(card => ![...state.board, ...holes.flat()].includes(card));
  return state;
}

test('unequal all-ins settle main pot and side pots separately', () => {
  const state = riverFixture();
  const contributions = [100, 200, 300, 300];
  state.players.forEach((p, i) => { p.contributed = contributions[i]; p.bet = contributions[i]; });
  state.currentBet = 300; state.pot = 900;
  const end = applyAction(state, { type: 'check' });
  assert.deepEqual(end.pots.map(p => p.amount), [400, 300, 200]);
  assert.deepEqual(end.pots.map(p => p.winners), [[0], [1], [2]]);
  assert.deepEqual(end.payouts, [400, 300, 200, 0]);
  assert.deepEqual(end.mainPotShares, [1, 0, 0, 0]);
  assert.equal(total(end), 901);
});

test('folded contributions remain in pots but cannot win', () => {
  const state = riverFixture();
  state.players.forEach(p => { p.contributed = 100; p.bet = 100; });
  state.players[0].folded = true; state.currentBet = 100; state.pot = 400;
  const end = applyAction(state, { type: 'check' });
  assert.deepEqual(end.mainPotWinners, [1]); assert.equal(end.payouts[1], 400);
});

test('board plays, fractional main-pot contracts differ from odd chip allocation', () => {
  const state = riverFixture();
  state.board = ['Ac', 'Kc', 'Qc', 'Jc', 'Tc'];
  state.players[0].hole = ['2d', '3d']; state.players[1].hole = ['4d', '5d'];
  state.players[2].hole = ['6d', '7d']; state.players[3].hole = ['8d', '9d'];
  state.players.forEach(p => { p.contributed = 5; p.bet = 0; });
  state.players[2].folded = true; state.pot = 20;
  const end = applyAction(state, { type: 'check' });
  assert.deepEqual(end.mainPotWinners, [0, 1, 3]);
  assert.deepEqual(end.mainPotShares, [1 / 3, 1 / 3, 0, 1 / 3]);
  assert.deepEqual(end.payouts, [6, 7, 0, 7]);
});

test('all-in calls run the remaining board once and settle', () => {
  let state = createHand(8, 0, 10);
  state = call(state); state = call(state); state = call(state);
  assert.equal(state.street, 'complete'); assert.equal(state.board.length, 5);
  assert.equal(total(state), 40);
  assert.equal(new Set([...state.board, ...state.players.flatMap(p => p.hole)]).size, 13);
});

test('hand ranks, wheel, flush kickers, two trips, and best five cards', () => {
  const rank = (s: string) => evaluate(s.split(' '));
  assert.ok(rank('As 2d 3h 4c 5s') < rank('2s 3d 4h 5c 6s'));
  assert.ok(rank('As Js 8s 5s 3s') > rank('As Ts 9s 5s 3s'));
  assert.equal(rank('As Ah Ad Ks Kh Kd 2c'), rank('As Ah Ad Ks Kh'));
  assert.ok(rank('Ac Kc Qc Jc Tc') > rank('As Ah Ad Ac Ks'));
  assert.ok(rank('As Ah Ad Ac 2s 3d 4h') > rank('Ks Kh Kd Kc As'));
  assert.ok(rank('As Ah Ad Ac Ks') > rank('As Ah Ad Ac Qs'));
  const best = evaluateHand('As Ah Ad Ks Kh Kd 2c'.split(' '));
  assert.equal(best.name, 'Full house'); assert.equal(best.cards.length, 5);
  assert.equal(evaluate(best.cards), best.rank);
});

test('seven-card evaluator equals exhaustive best five on random deals', () => {
  for (let i = 0; i < 200; i++) {
    const cards = shuffledDeck(i).slice(0, 7), values: number[] = [];
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 7; b++) values.push(evaluate(cards.filter((_, j) => j !== a && j !== b)));
    assert.equal(evaluate(cards), Math.max(...values));
  }
});

test('private projection is invariant to opponent hands, deck, and seed', () => {
  const state = toFlop(), changed = copy(state), seat = state.actor!;
  const others = state.players.filter(p => p.seat !== seat).map(p => p.seat);
  [changed.players[others[0]].hole, changed.players[others[1]].hole] = [changed.players[others[1]].hole, changed.players[others[0]].hole];
  changed.deck.reverse(); changed.seed = 'secret changed';
  assert.deepEqual(getObservation(state, seat), getObservation(changed, seat));
  const observation = getObservation(state, seat);
  assert.equal('deck' in observation, false); assert.equal('seed' in observation, false);
  assert.ok(observation.players.every(p => !('hole' in p)));
  assert.deepEqual(decidePractice(observation, 123), decidePractice(getObservation(changed, seat), 123));
  const spectator = getSpectator(state);
  assert.equal('deck' in spectator, false); assert.equal('seed' in spectator, false);
  assert.equal(spectator.players.flatMap(p => p.hole).length, 8);
  spectator.players[0].hole[0] = 'bad';
  assert.notEqual(state.players[0].hole[0], 'bad');
});

test('random legal play conserves chips and terminates across 500 deals', () => {
  let random = 37;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  for (let deal = 0; deal < 500; deal++) {
    let state = createHand(deal, deal % 4), steps = 0;
    while (state.street !== 'complete') {
      assert.ok(++steps < 200);
      const legal = legalActions(state), options: Action[] = [];
      if (legal.canFold) options.push({ type: 'fold' });
      if (legal.canCheck) options.push({ type: 'check' });
      if (legal.canCall) options.push({ type: 'call' });
      if (legal.canRaise) options.push({ type: 'raise', amount: legal.minRaiseTo! + next() % (legal.maxRaiseTo - legal.minRaiseTo! + 1) });
      const input = state, before = copy(state);
      state = applyAction(state, options[next() % options.length]);
      assert.equal(total(state), 4000);
      assert.ok(state.players.every(p => Number.isSafeInteger(p.stack) && p.stack >= 0));
      assert.deepEqual(input, before);
      if (state.actor !== null) assert.ok(!state.players[state.actor].folded && !state.players[state.actor].allIn);
      assert.equal(new Set([...state.board, ...state.players.flatMap(p => p.hole)]).size, state.board.length + 8);
    }
    assert.ok(Math.abs(state.mainPotShares.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    assert.equal(state.payouts.reduce((a, b) => a + b, 0), state.pot);
  }
});

test('decisions replay exactly and practice players complete legal hands', () => {
  for (let seed = 0; seed < 40; seed++) {
    let state = createHand(seed, seed % 4), replay = createHand(seed, seed % 4), count = 0;
    while (state.street !== 'complete') {
      assert.ok(++count < 200);
      const action = decidePractice(getObservation(state, state.actor!), seed * 1000 + count);
      state = applyAction(state, action); replay = applyAction(replay, action);
    }
    assert.deepEqual(state, replay); assert.equal(total(state), 4000);
  }
});

test('forecast is normalized, deterministic, excludes folded outcomes and ignores real future deck', () => {
  let state = createHand(30, 0);
  state = applyAction(state, { type: 'fold' });
  const changed = copy(state); changed.deck.reverse(); changed.seed = 123456;
  const values = estimateValues(state, 12, 12);
  assert.equal(values[3], 0);
  assert.ok(values.every(p => p >= 0 && p <= 1));
  assert.ok(Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.deepEqual(values, estimateValues(changed, 12, 12));
  const end = toEnd(state);
  assert.deepEqual(estimateValues(end, 1, 12), end.mainPotShares);
});

test('fixed royal board has exactly equal contract forecasts with no remaining betting', () => {
  const state = riverFixture();
  state.board = ['Ac', 'Kc', 'Qc', 'Jc', 'Tc'];
  const holes = [['2d', '3d'], ['4d', '5d'], ['6d', '7d'], ['8d', '9d']];
  state.players.forEach((player, seat) => { player.hole = holes[seat]; player.contributed = 100; });
  state.pot = 400;
  assert.deepEqual(estimateValues(state, 941, 32), [0.25, 0.25, 0.25, 0.25]);
});

test('all-in quads on the turn are locked despite outstanding side-pot action', () => {
  const state = riverFixture();
  state.street = 'turn'; state.board = ['Ac', 'Ad', 'Ah', 'Kc'];
  const holes = [['As', '2s'], ['Ks', 'Kh'], ['Qs', 'Qh'], ['Js', 'Jh']];
  state.players.forEach((player, seat) => {
    player.hole = holes[seat]; player.contributed = 100;
    player.stack = seat === 0 ? 0 : 200; player.allIn = seat === 0;
  });
  state.pot = 400; state.pending = [1, 2, 3]; state.actor = 1;
  const unseen = fullDeck().filter(card => ![...state.board, ...holes.flat()].includes(card));
  // Independent combinatorial ground truth: seat 0 beats all three opponents
  // on every possible final card, and cannot fold because already all-in.
  for (const river of unseen) {
    const ranks = holes.map(hole => evaluate([...hole, ...state.board, river]));
    assert.ok(ranks.slice(1).every(rank => rank < ranks[0]));
  }
  const values = estimateValues(state, 181, 256);
  assert.ok(values[0] > 0.99);
  assert.ok(values.slice(1).every(value => value > 0 && value < 0.003));
});

test('small-sample forecasts agree in aggregate with held-out higher-sample references', () => {
  const fixtures = [createHand(33, 0), createHand(114, 2), toFlop()];
  for (let fixture = 0; fixture < fixtures.length; fixture++) {
    const state = fixtures[fixture];
    const reference = estimateValues(state, 88000 + fixture, 4096);
    const aggregate = [0, 0, 0, 0];
    let squaredError = 0;
    for (let trial = 0; trial < 16; trial++) {
      const prediction = estimateValues(state, fixture * 1000 + trial + 100, 96);
      for (let seat = 0; seat < 4; seat++) {
        aggregate[seat] += prediction[seat] / 16;
        squaredError += (prediction[seat] - reference[seat]) ** 2;
      }
    }
    assert.ok(Math.sqrt(squaredError / 64) < 0.06, '96-rollout forecast RMS error must be below six percentage points');
    for (let seat = 0; seat < 4; seat++) assert.ok(Math.abs(aggregate[seat] - reference[seat]) < 0.035, 'Aggregate systematic error below 3.5 percentage points');
  }
});

test('finite rollouts never label an unfolded outcome impossible', () => {
  const state = createHand(40, 0);
  const values = estimateValues(state, 80, 1);
  assert.ok(values.every(value => value > 0 && value < 1));
  assert.throws(() => estimateValues(state, 1, Number.NaN));
});
