#!/usr/bin/env node
// Opt-in integration verification. Uses the real server, poker providers, Jev,
// rules engine, and matching engine, with an isolated in-memory D1 adapter.
// Run manually: node --experimental-strip-types --env-file=.dev.vars \
//   scripts/verify-live-market.mjs --allow-paid-models
// Never included in the test suite or CI. This makes paid Gateway requests.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Manual paid integration run: node --experimental-strip-types --env-file=.dev.vars scripts/verify-live-market.mjs --allow-paid-models [--output PATH]');
  process.exit(0);
}
if (!args.includes('--allow-paid-models')) {
  console.error('Refusing paid model calls. Supply --allow-paid-models explicitly. No requests made.');
  process.exit(2);
}
const outputIndex = args.indexOf('--output');
const unknown = args.filter((arg, index) => arg !== '--allow-paid-models' && arg !== '--output' && !(outputIndex >= 0 && index === outputIndex + 1));
if (unknown.length || (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--')))) throw new Error('Unknown or incomplete arguments. Use --help.');
const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error('AI_GATEWAY_API_KEY must be supplied through process.env; no requests made.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, outputIndex >= 0 ? args[outputIndex + 1] : 'outputs/live-market-report.json');
const started = Date.now(), MAX_MS = 10 * 60 * 1000, MAX_ACTIONS = 120;
const wall = new AbortController();
let fatal = null, stopped = false, sessionId, actions = 0, tickTask;
const fail = error => { fatal ??= error instanceof Error ? error : new Error(String(error)); wall.abort(fatal); };
const safeError = error => String(error?.message ?? error).replaceAll(apiKey, '[redacted]');
const sourceFiles = ['lib/server.ts', 'lib/game.ts', 'lib/market.ts', 'lib/market-agents.ts', 'lib/providers.ts', 'scripts/verify-live-market.mjs'];
let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* file hashes still identify tested sources */ }
const report = {
  kind: 'REAL LIVE MODEL INTEGRATION; isolated in-memory database; no browser/auth UI coverage',
  startedAt: new Date(started).toISOString(), status: 'running',
  configuration: { hands: 5, ranked: false, pokerPacingMs: 3000, tickPollingMs: 1000, maximumActions: MAX_ACTIONS, hardWallMs: MAX_MS },
  source: { commit, sha256: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])) },
  providerCalls: [], successfulModelCounts: {}, jevChoiceCounts: {}, jevChoiceFamilies: {},
  reportedCostUsd: null, conservationChecks: 0, hands: {}, snapshots: [], humanOrders: [], assertions: {},
};
function save() {
  report.elapsedMs = Date.now() - started;
  report.reportedCostCoverage = costCoverage(report.providerCalls);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2));
  renameSync(`${output}.tmp`, output);
}
const timer = setTimeout(() => { fail(new Error('Ten-minute hard wall reached.')); save(); }, MAX_MS);
const sleep = ms => new Promise(resolve => {
  if (wall.signal.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); wall.signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); wall.signal.addEventListener('abort', finish, { once: true });
});
function check() { if (fatal) throw fatal; if (Date.now() - started >= MAX_MS) throw new Error('Ten-minute hard wall reached.'); }

// Only platform bindings are adapted. No provider, fetch response, poker,
// equity, candidate selection, or market implementation is replaced.
const storage = new DatabaseSync(':memory:');
for (const migration of readdirSync(resolve(root, 'drizzle')).filter(name => name.endsWith('.sql')).sort()) storage.exec(readFileSync(resolve(root, 'drizzle', migration), 'utf8'));
class Query {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Query(this.sql, values); }
  first() { return storage.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: storage.prepare(this.sql).all(...this.values) }; }
  run() { return { meta: { changes: Number(storage.prepare(this.sql).run(...this.values).changes) } }; }
}
const database = {
  prepare: sql => new Query(sql),
  batch(queries) {
    storage.exec('BEGIN');
    try { const result = queries.map(query => query.run()); storage.exec('COMMIT'); return result; }
    catch (error) { storage.exec('ROLLBACK'); throw error; }
  },
};
globalThis.__vesperLiveVerificationEnv = {
  DB: database, AI_GATEWAY_API_KEY: apiKey, LIVE_MODELS_READY: 'true',
  ...Object.fromEntries(['POKER_MODEL_GPT', 'POKER_MODEL_CLAUDE', 'POKER_MODEL_GEMINI', 'POKER_MODEL_GROK'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
};
registerHooks({ resolve(specifier, context, next) {
  const aliases = {
    'cloudflare:workers': 'export const env=globalThis.__vesperLiveVerificationEnv;',
    'next/headers': 'export const cookies=async()=>({get:()=>undefined,set:()=>{}}); export const headers=async()=>new Headers();',
    'next/navigation': "export function redirect(){throw new Error('Unexpected redirect in isolated runner');}",
  };
  if (specifier in aliases) return { url: 'data:text/javascript,' + encodeURIComponent(aliases[specifier]), shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[a-z]+$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const realFetch = globalThis.fetch;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+(\.\d+)?([eE]-?\d+)?$/.test(value) ? Number(value) : undefined;
function usageMetadata(body) {
  const result = {};
  for (const source of ['usage', 'cost']) {
    const value = body?.[source];
    if (!value || typeof value !== 'object') continue;
    const clean = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cost', 'total_cost', 'input_cost', 'output_cost', 'upstream_inference_cost', 'promptTokens', 'completionTokens', 'totalTokens', 'inputTokens', 'outputTokens', 'totalCost', 'inputCost', 'outputCost', 'upstreamInferenceCost']) {
      const number = numeric(value[key]); if (number !== undefined) clean[key] = number;
    }
    if (value.cost_details && typeof value.cost_details === 'object') {
      const number = numeric(value.cost_details.upstream_inference_cost);
      if (number !== undefined) clean.cost_details = { upstream_inference_cost: number };
    }
    if (Object.keys(clean).length) result[source] = clean;
  }
  const gatewayCost = numeric(body?.providerMetadata?.gateway?.cost);
  if (gatewayCost !== undefined) result.providerMetadata = { gateway: { cost: gatewayCost } };
  return result;
}
function costCoverage(calls) {
  const successful = calls.filter(call => call.status === 'http_success');
  const missing = successful.filter(call => call.reportedCostUsd === undefined);
  return {
    successfulRequests: successful.length,
    requestsWithReportedCost: successful.length - missing.length,
    requestsMissingCost: missing.length,
    missingByModel: Object.fromEntries([...new Set(missing.map(call => call.model))].map(model => [model, missing.filter(call => call.model === model).length])),
    completeForSuccessfulRequests: successful.length > 0 && missing.length === 0,
    failedRequests: calls.filter(call => call.status === 'failed').length,
    note: 'This is a subtotal of returned per-request costs, not a verified account billing total. Missing metadata and any unreported charges are excluded.',
  };
}
function choiceFamily(choice) {
  if (choice === 'tight_quotes' || choice === 'wide_quotes' || choice === 'hold' || choice === 'cancel_quotes') return choice;
  if (/^(bullish|bearish)_/.test(choice)) return choice.split('_')[0];
  if (choice.endsWith('_value')) return 'value';
  if (choice.endsWith('_conviction')) return 'conviction';
  return 'book_take';
}
globalThis.fetch = async (input, init) => {
  check();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!['https://ai-gateway.vercel.sh/v1/chat/completions', 'https://ai-gateway.vercel.sh/v1/evaluate'].includes(url)) throw new Error('Unexpected network destination in live integration runner.');
  const model = JSON.parse(String(init?.body)).model;
  const entry = { model, endpoint: url.endsWith('/evaluate') ? 'evaluate' : 'chat/completions', startedAt: new Date().toISOString(), hand: currentHand(), status: 'pending' };
  report.providerCalls.push(entry);
  const began = Date.now();
  try {
    const signals = [wall.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
    const response = await realFetch(input, { ...init, signal: AbortSignal.any(signals) });
    entry.httpStatus = response.status;
    if (!response.ok) { entry.status = 'failed'; throw new Error(`${model} returned HTTP ${response.status}; response body omitted.`); }
    const body = await response.clone().json();
    if (body?.error) throw new Error(`${model} returned an error payload; response body omitted.`);
    entry.status = 'http_success'; entry.usage = usageMetadata(body);
    report.successfulModelCounts[model] = (report.successfulModelCounts[model] ?? 0) + 1;
    const costSources = [
      ['providerMetadata.gateway.cost', entry.usage.providerMetadata?.gateway?.cost],
      ['usage.cost', entry.usage.usage?.cost],
      ['usage.total_cost', entry.usage.usage?.total_cost],
      ['usage.totalCost', entry.usage.usage?.totalCost],
      ['cost.total_cost', entry.usage.cost?.total_cost],
      ['cost.totalCost', entry.usage.cost?.totalCost],
    ];
    const cost = costSources.find(([, amount]) => amount !== undefined);
    if (cost) { entry.reportedCostSource = cost[0]; entry.reportedCostUsd = cost[1]; report.reportedCostUsd = (report.reportedCostUsd ?? 0) + cost[1]; }
    if (entry.endpoint === 'evaluate') {
      entry.choiceCounts = {};
      for (const answer of Object.values(body.answers ?? {})) {
        const choice = answer?.choice;
        if (typeof choice !== 'string' || !/^(tight_quotes|wide_quotes|hold|cancel_quotes|(bullish|bearish)_[0-3]|(buy|sell)_[0-3]_(value|conviction|3|5|6|15))$/.test(choice)) continue;
        entry.choiceCounts[choice] = (entry.choiceCounts[choice] ?? 0) + 1;
        report.jevChoiceCounts[choice] = (report.jevChoiceCounts[choice] ?? 0) + 1;
        const family = choiceFamily(choice); report.jevChoiceFamilies[family] = (report.jevChoiceFamilies[family] ?? 0) + 1;
      }
    }
    return response;
  } catch (error) {
    entry.status = 'failed'; entry.error = safeError(error); fail(new Error(`${model} request failed: ${safeError(error)}`)); throw error;
  } finally { entry.latencyMs = Date.now() - began; save(); }
};
const server = await import('../lib/server.ts');
const { UNITS_PER_CREDIT } = await import('../lib/market.ts');
const { JEV_MODEL } = await import('../lib/market-agents.ts');
const owner = { id: randomUUID(), authenticated: true };
function currentHand() {
  if (!sessionId) return null;
  const row = storage.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId);
  return row ? JSON.parse(row.state).hand : null;
}
function verifyConservation(raw) {
  const market = raw.market, accounts = Object.values(market.accounts);
  assert.equal(accounts.reduce((sum, account) => sum + account.cashUnits, market.collateralUnits), market.initialTotalCashUnits, 'Cash plus settlement collateral must be conserved.');
  for (const account of accounts) {
    assert.ok(Number.isSafeInteger(account.cashUnits) && account.cashUnits >= 0, 'All accounts remain funded.');
    const orders = market.orders.filter(order => order.owner === account.id);
    const reservedCash = orders.filter(order => order.side === 'buy').reduce((sum, order) => sum + order.remaining * order.priceTicks * UNITS_PER_CREDIT / 100, 0);
    assert.ok(reservedCash <= account.cashUnits, 'Buy orders cannot over-reserve cash.');
    account.shares.forEach((quantity, outcome) => {
      assert.ok(Number.isSafeInteger(quantity) && quantity >= 0, 'No negative or fractional inventory.');
      assert.ok(orders.filter(order => order.side === 'sell' && order.outcome === outcome).reduce((sum, order) => sum + order.remaining, 0) <= quantity, 'Sell orders cannot over-reserve shares.');
    });
  }
  for (let outcome = 0; outcome < 4; outcome++) assert.equal(accounts.reduce((sum, account) => sum + account.shares[outcome], 0), market.status === 'settled' ? 0 : market.completeSetsIssued, 'Outcome shares are conserved until redemption.');
  report.conservationChecks++;
}
const forbidden = new Set(['deck', 'seed', 'rngState', 'values', 'accounts', 'bias', 'beliefs', 'marketAgents', 'hole']);
function verifyPublic(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) { assert.ok(!forbidden.has(key), `Public session unexpectedly contains ${key}.`); verifyPublic(nested); }
}
let previous;
async function snapshot(event) {
  check();
  let view, raw;
  // A concurrent poker/market commit can occur during getSession's await.
  // Pair the public projection with the same persisted version for checks.
  do {
    view = await server.getSession(owner, sessionId);
    raw = JSON.parse(storage.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId).state);
  } while (raw.version !== view.version);
  verifyPublic(view); verifyConservation(raw);
  if (view.market.agentNotice && /unavailable|call limit/i.test(view.market.agentNotice)) throw new Error(view.market.agentNotice);
  const hand = report.hands[view.hand] ??= { hand: view.hand, significantPriceChanges: [], filledShares: 0, syntheticFilledShares: 0, humanBought: 0, humanSold: 0, histories: [] };
  hand.filledShares = Math.max(hand.filledShares, view.market.books.reduce((sum, book) => sum + book.volume, 0));
  hand.syntheticFilledShares = Math.max(hand.syntheticFilledShares, raw.market.fills.filter(fill => fill.buyer !== 'human' && fill.seller !== 'human').reduce((sum, fill) => sum + fill.quantity, 0));
  if (previous?.hand === view.hand && previous.status === 'playing' && view.status === 'playing') {
    for (const book of view.market.books) {
      if (view.players[book.outcome].folded || previous.players[book.outcome].folded) continue;
      const prior = previous.market.books[book.outcome];
      const before = prior.midpoint ?? prior.lastPrice, after = book.midpoint ?? book.lastPrice;
      if (before != null && after != null && Math.abs(before - after) >= .02 - 1e-9) {
        const change = { at: new Date().toISOString(), tick: view.market.tick, street: view.street, outcome: book.outcome, before, after, pokerRevision: view.pokerRevision };
        hand.significantPriceChanges.push(change);
        if (hand.significantPriceChanges.length <= 3) console.log(`Hand ${view.hand}: ${view.players[book.outcome].name} ${(100 * before).toFixed(1)}¢ → ${(100 * after).toFixed(1)}¢; ${hand.filledShares} filled shares.`);
      }
    }
  }
  hand.histories.push({ version: view.version, tick: view.market.tick, street: view.street, history: view.market.history });
  report.snapshots.push({ event, at: new Date().toISOString(), elapsedMs: Date.now() - started, session: view });
  previous = view; save(); return view;
}
async function command(body, event = body.type) {
  check();
  await server.executeCommand(owner, sessionId, { ...body, requestId: randomUUID() });
  return snapshot(event);
}
async function trade(view) {
  if (view.status !== 'playing') return;
  const hand = report.hands[view.hand];
  let side, book, quantity;
  if (hand.humanBought < 2) {
    quantity = 2 - hand.humanBought;
    book = view.market.books.find(book => !view.players[book.outcome].folded && book.bestAsk != null && book.asks[0]?.quantity >= quantity);
    side = 'buy';
  } else if (!hand.humanSold && view.pokerRevision > hand.boughtAtRevision) {
    book = view.market.books.find(book => !view.players[book.outcome].folded && book.bestBid != null && view.market.positions[book.outcome].availableQuantity >= 1);
    quantity = 1; side = 'sell';
  }
  if (!book) return; // Empty book or folded holdings: retry on a later action.
  const before = view.market.positions[book.outcome].quantity;
  const next = await command({ type: 'order', hand: view.hand, pokerRevision: view.pokerRevision, outcome: book.outcome, side, quantity, limitPrice: side === 'buy' ? book.bestAsk : book.bestBid, orderType: 'ioc' }, `human_${side}`);
  const filled = side === 'buy' ? next.market.positions[book.outcome].quantity - before : before - next.market.positions[book.outcome].quantity;
  report.humanOrders.push({ hand: view.hand, side, outcome: book.outcome, requested: quantity, filled, limitPrice: side === 'buy' ? book.bestAsk : book.bestBid, cashAfter: next.market.cash });
  if (side === 'buy') { hand.humanBought += filled; if (filled) hand.boughtAtRevision = view.pokerRevision; }
  else hand.humanSold += filled;
  save();
}

// Temporal integration evidence, not a claim that a stochastic price move has
// a uniquely proven cause. Excludes opening movement, automatic folded zeros,
// settlement, human trades, and responses prepared before the poker event.
function eventLinkedRepricing(snapshots, calls) {
  const evidence = [];
  for (let index = 1; index < snapshots.length; index++) {
    const event = snapshots[index], prior = snapshots[index - 1].session, view = event.session;
    if (view.status !== 'playing' || prior.hand !== view.hand || prior.pokerRevision === view.pokerRevision) continue;
    const boardChanged = JSON.stringify(prior.board) !== JSON.stringify(view.board);
    const foldedSeats = view.players.filter(player => player.folded && !prior.players[player.seat].folded).map(player => player.seat);
    if (!boardChanged && !foldedSeats.length) continue;
    const following = [];
    for (const frame of snapshots.slice(index + 1)) {
      if (frame.session.hand !== view.hand || frame.session.pokerRevision !== view.pokerRevision || frame.session.status !== 'playing' || frame.event.startsWith('human_')) break;
      following.push(frame);
    }
    for (const [callIndex, call] of calls.entries()) {
      if (call.hand !== view.hand || call.endpoint !== 'evaluate' || call.status !== 'http_success' || !Number.isFinite(call.latencyMs) || Date.parse(call.startedAt) < Date.parse(event.at)) continue;
      const completedAt = Date.parse(call.startedAt) + call.latencyMs;
      const after = following.find(frame => frame.event === 'tick' && Date.parse(frame.at) >= completedAt);
      if (!after) continue;
      // Compare against the most recent snapshot before this fresh request.
      const before = [event, ...following].filter(frame => Date.parse(frame.at) <= Date.parse(call.startedAt)).at(-1);
      const changes = view.market.books.flatMap(book => {
        if (view.players[book.outcome].folded) return [];
        const a = before.session.market.books[book.outcome], b = after.session.market.books[book.outcome];
        const from = a.midpoint ?? a.lastPrice, to = b.midpoint ?? b.lastPrice;
        return from != null && to != null && Math.abs(to - from) >= .02 - 1e-9 ? [{ outcome: book.outcome, before: from, after: to }] : [];
      });
      if (!changes.length) continue;
      evidence.push({ hand: view.hand, pokerRevision: view.pokerRevision, boardChanged, foldedSeats,
        eventAt: event.at, eventSnapshotIndex: index, beforeAt: before.at, afterAt: after.at,
        jevCallIndex: callIndex, jevStartedAt: call.startedAt, jevCompletedAt: new Date(completedAt).toISOString(),
        changes, filledShareDelta: after.session.market.books.reduce((sum, book, seat) => sum + book.volume - before.session.market.books[seat].volume, 0) });
      break;
    }
  }
  return evidence;
}

try {
  const initial = await server.startSession(owner, { requestId: randomUUID(), mode: 'live', ranked: false, personalitiesEnabled: true });
  sessionId = initial.id; report.sessionId = sessionId; report.models = server.modelIds();
  assert.equal(initial.market.driver, 'jev');
  assert.equal(new Set(report.models).size, 4, 'All four poker seats must use distinct model IDs.');
  await snapshot('start');
  tickTask = (async () => {
    while (!stopped && !fatal) {
      const began = Date.now();
      try { await command({ type: 'tick' }); } catch (error) { fail(error); break; }
      await sleep(Math.max(0, 1000 - (Date.now() - began)));
    }
  })();
  let observedHand = 0;
  while (true) {
    check();
    let view = await server.getSession(owner, sessionId);
    if (view.status === 'complete') break;
    if (view.hand !== observedHand) {
      observedHand = view.hand;
      console.log(`Hand ${view.hand}/5 started. Real poker models and Jev; isolated database.`);
      // Let real Jev post opening liquidity before the first human order.
      const until = Date.now() + 12000;
      while (Date.now() < until && !view.market.books.some(book => book.bestAsk != null)) {
        await sleep(250); check(); view = await server.getSession(owner, sessionId);
      }
    }
    await trade(view);
    view = await server.getSession(owner, sessionId);
    if (view.status === 'hand_complete') {
      await snapshot('hand_complete');
      console.log(`Hand ${view.hand} complete: PnL ${view.results.at(-1).pnl.toFixed(2)}; reported Gateway cost ${report.reportedCostUsd == null ? 'not supplied' : '$' + report.reportedCostUsd.toFixed(6)}.`);
      await command({ type: 'next_hand', pokerRevision: view.pokerRevision });
      continue;
    }
    await sleep(3000); check();
    view = await server.getSession(owner, sessionId);
    if (++actions > MAX_ACTIONS) throw new Error('Maximum 120 poker actions reached.');
    await command({ type: 'advance', pokerRevision: view.pokerRevision });
  }
  stopped = true;
  await tickTask;
  const final = await snapshot('complete');
  report.final = { cash: final.market.cash, pnl: final.pnl, results: final.results, actions };
  report.eventLinkedPriceChanges = eventLinkedRepricing(report.snapshots, report.providerCalls);
  const checks = {
    completeFiveHands: final.status === 'complete' && final.results.length === 5 && final.hand === 5,
    pnlEqualsFinalCashLess1000: Math.abs(final.pnl - (final.market.cash - 1000)) < 1e-9,
    summedHandPnlMatchesFinal: Math.abs(final.results.reduce((sum, result) => sum + result.pnl, 0) - final.pnl) < 1e-8,
    allFourPokerModelsCalled: report.models.every(model => report.successfulModelCounts[model] > 0),
    jevCalled: report.successfulModelCounts[JEV_MODEL] > 0,
    realFillsEveryHand: [1, 2, 3, 4, 5].every(hand => report.hands[hand]?.filledShares > 0),
    syntheticFillsEveryHand: [1, 2, 3, 4, 5].every(hand => report.hands[hand]?.syntheticFilledShares > 0),
    significantNonSettlementPriceChangesEveryHand: [1, 2, 3, 4, 5].every(hand => report.hands[hand]?.significantPriceChanges.length > 0),
    freshJevRepricingAfterBoardOrFoldEveryHand: [1, 2, 3, 4, 5].every(hand => report.eventLinkedPriceChanges.some(event => event.hand === hand)),
    humanBoughtTwoShares: Object.values(report.hands).some(hand => hand.humanBought === 2),
    humanSoldOneShareLater: Object.values(report.hands).some(hand => hand.humanSold >= 1),
    fundsConserved: report.conservationChecks > 0,
    publicProjectionContainsNoDeck: true,
  };
  report.assertions = checks;
  assert.ok(Object.values(checks).every(Boolean), `Verification failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`);
  report.status = 'passed';
  console.log(`PASS: five hands; final PnL ${final.pnl.toFixed(2)}. Report: ${output}`);
} catch (error) {
  fail(error); report.status = 'failed'; report.error = safeError(error);
  console.error(`Live verification failed: ${report.error}`); process.exitCode = 1;
} finally {
  stopped = true; wall.abort();
  if (tickTask) await tickTask.catch(() => {});
  clearTimeout(timer); globalThis.fetch = realFetch;
  report.finishedAt = new Date().toISOString(); save(); storage.close();
}
