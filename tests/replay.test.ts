import test from "node:test";
import assert from "node:assert/strict";
import { createGame, commandGame, viewGame } from "../lib/game.ts";
import { createReplayFrame, shouldRecordReplay } from "../lib/replay.ts";

const NOW = Date.UTC(2026, 9, 14, 12);

test("replay freezes the public view without future cards or modifying the game", () => {
  const game = createGame("replay-test", "practice", false, NOW);
  const frame = createReplayFrame(game, "deal", NOW);
  assert.deepEqual(frame.session.board, []);
  assert.equal(frame.session.tradingOpen, false);
  assert.equal(frame.session.busy, false);
  assert.equal(frame.session.marketSecondsRemaining, 0);
  assert.equal(viewGame(game, false, NOW).tradingOpen, true);
  assert.equal(viewGame(game, false, NOW).replayAvailable, false);
  assert.equal(JSON.stringify(frame).includes('"deck"'), false);
  assert.equal(JSON.stringify(frame).includes('"seed"'), false);
  const cards = [...frame.session.players[0].cards];
  game.poker.players[0].hole.reverse();
  assert.deepEqual(frame.session.players[0].cards, cards);
});

test("record actions and human resting-order fills, without idle market tick frames", async () => {
  const game = createGame("replay-ticks", "practice", false, NOW);
  const next = await commandGame(game, { type: "tick" }, NOW + 1000);
  const idle = structuredClone(game); idle.market.tick++;
  assert.equal(shouldRecordReplay(game, idle, "tick"), false);
  assert.equal(shouldRecordReplay(game, next, "advance"), true);
  assert.equal(shouldRecordReplay(game, next, "order"), true);
  assert.equal(shouldRecordReplay(game, next, "cancel"), true);
  next.market.accounts.human.cashUnits -= 1200;
  assert.equal(shouldRecordReplay(game, next, "tick"), true);
});

test("saved frames retain all five hands and trades while later game states change", async t => {
  t.mock.method(Date, "now", () => NOW);
  let game = createGame("replay-complete", "live", false, NOW);
  const frames = [createReplayFrame(game, "deal", NOW)];
  const ask = viewGame(game, false, NOW).market.books.find(book => book.bestAsk != null)!;
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: ask.outcome, side: "buy", quantity: 2, limitPrice: ask.bestAsk!, orderType: "ioc" }, NOW);
  frames.push(createReplayFrame(game, "order", NOW));
  let actions = 0;
  while (viewGame(game, false, NOW).status !== "complete") {
    const type = game.poker.street === "complete" ? "next_hand" : "advance";
    game = await commandGame(game, { type, pokerRevision: game.poker.revision }, NOW,
      async observation => observation.legal.canFold ? { type: "fold" } : { type: "check" });
    frames.push(createReplayFrame(game, type, NOW));
    assert.ok(++actions < 200);
  }
  assert.deepEqual([...new Set(frames.map(frame => frame.session.hand))], [1, 2, 3, 4, 5]);
  assert.equal(frames[0].session.results.length, 0);
  assert.equal(frames[1].session.activity.at(-1)?.kind, "trade");
  assert.equal(frames.at(-1)?.session.status, "complete");
  assert.equal(frames.at(-1)?.session.results.length, 5);
  assert.equal(frames.at(-1)?.session.replayAvailable, true);
  assert.equal(frames.at(-1)?.session.pnl, viewGame(game, false, NOW).pnl);
  assert.ok(frames.every(frame => !frame.session.tradingOpen));
});

test("legacy completed games do not offer a replay that was never recorded", () => {
  const game = createGame("legacy-game", "practice", false, NOW);
  delete game.replayVersion;
  game.hand = 5;
  game.poker.street = "complete";
  assert.equal(viewGame(game, false, NOW).replayAvailable, false);
});

test("replay recording includes resting orders leaving the book without changing cash", () => {
  const game = createGame("order-book-game", "practice", false, NOW);
  const order = game.market.orders[0];
  game.market.orders.push({ ...order, id: "human-resting-order", owner: "human" });
  const next = structuredClone(game);
  next.market.orders = next.market.orders.filter(order => order.id !== "human-resting-order");
  assert.equal(shouldRecordReplay(game, next, "tick"), true);
});


test("recorded book depth and volume survive later quote changes without a human trade", () => {
  const game=createGame('depth-history','practice',false,NOW);
  const frame=createReplayFrame(game,'tick',NOW);
  const next=structuredClone(game);
  next.market.orders[0].remaining+=1;
  assert.equal(shouldRecordReplay(game,next,'tick'),true);
  assert.notDeepEqual(viewGame(next,false,NOW).market.books,frame.session.market.books);
  assert.deepEqual(frame.session.market.books,viewGame(game,false,NOW).market.books);
  const volume=structuredClone(game);volume.market.volumes[0]++;
  assert.equal(shouldRecordReplay(game,volume,'tick'),true);
  assert.match(frame.label,/Market snapshot/);
  assert.match(frame.label,/Hand 1/);
});
