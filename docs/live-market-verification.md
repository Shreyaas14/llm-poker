# Live market repricing verification

The remaining stale-price defect was reproduced with real Jev responses on
2026-10-14. Even after PR #20 introduced equity-responsive quotes, Jev repeatedly
selected `market_quotes`, which reused the old book marks. A river winner with
100% showdown equity remained priced around 45.5¢. This follow-up removes that
option, adds bounded directional quote portfolios and equity-based trading
limits, and supplies visible bets and contributions to Jev.

PR #16 remains reverted. This change does not restore normalized display prices,
complete-set arbitrage, or the reverted liquidity changes.

## Observed reactions

The full run passed in 179.25 seconds: five settled hands, 30 successful poker
requests across all four providers, 59 successful Jev requests, and 2,759 shares
traded between synthetic traders. Human buys and sells executed, and the final
997.89-credit balance matched the −2.11 score and summed hand PnL. Every sampled
state passed cash and inventory conservation checks. [Compact evidence](pr-evidence/live-market-events.json)
records source hashes, assertions, call counts, and event comparisons. The
reported cost subtotal omits Jev's differently shaped cost metadata and is not
the total cost of the run.

After the run, the runner's reporting was tightened to include Jev cost metadata
and require a fresh Jev response following a board reveal or fold in every hand.
An offline audit of the recorded run passed that stricter check for all five
hands (11 qualifying events); opening-only snapshots did not pass. All five
runtime source hashes still match the tested files. The recorded runner hash
identifies the version that made the paid calls, before those reporting edits.

These examples come from real provider calls through the actual production
server functions and funded matching engine. Each comparison pairs a poker
event with a completed Jev request started after that event, before the next
poker revision. Neither example has an intervening human trade.

| Event | Showdown equity | Market quote | Response observed |
| --- | --- | --- | --- |
| Hand 2: 9♠ turn, GPT | 44.63% → 25% | 49¢ → 30.5¢ | 1.70 seconds |
| Hand 2: 9♠ turn, Claude | 55.37% → 75% | 55.5¢ → 69.5¢ | 1.70 seconds |
| Hand 1: Gemini folds, Grok | 49.66% → 74.35% | 47.5¢ → 76.5¢ | 2.06 seconds |

These are observed event-linked reactions, not a statistical calibration claim.
The live makers selected responsive tight quotes in this run; the run does not
establish that Jev reliably identifies bluffs or selects directional portfolios.
Markets still reflect executable orders and can temporarily differ from card
equity. No prices or fills are animated into existence.

## Reproduction

Run only with an explicitly authorized, capped Gateway key:

```sh
node --experimental-strip-types --env-file=.dev.vars scripts/verify-live-market.mjs --allow-paid-models
```

This opt-in runner uses the real poker providers and Jev, an isolated in-memory
SQLite adapter for D1, and the production server, poker, and exchange code. It
does not mock model decisions. It covers five hands, concurrent market polling,
human buys and sells, settlement, score, and cash/share conservation. It does
not exercise production authentication or the production D1 network layer.
It refuses to make requests without `--allow-paid-models` and is not in CI.

Browser checks separately verified visible quote changes, folded-player marks,
executed synthetic positions, a ten-share human purchase, cash, and holdings.
The complete five-hand test uses the isolated runner because another local
browser session was resetting the shared preview account.
