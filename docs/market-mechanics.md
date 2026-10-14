# Market Mechanics and Live Configuration

[Back to the README](../README.md)

## Settlement and order matching

Four-seat no-limit Texas Hold’em uses 1,000-chip starting stacks, a rotating dealer, and 5/10 blinds. The main pot determines prediction contracts; side-pot winners do not. A sole winner pays $1 per share; k tied main-pot winners each pay $1/k. Integer settlement units preserve thirds exactly. Each new hand creates fresh outcome books and synthetic accounts; the human carries settled cash forward.

The sixteen traders are two makers, four value, three equity, two momentum, two contrarian, and three noise traders. Makers begin with $1,800 of funding, including 700 collateral-backed complete sets; others begin with $800, including 240 complete sets. Funding is fixed for the hand. Live maker menus offer three levels per side, sized 8/16/24 shares; orders are clamped to available cash and owned shares. A complete set contains one share in each of the four outcomes and is backed by $1 of collateral.

Price-time priority, maker-price execution, partial fills, reserved cash/shares, and self-trade prevention apply to all participants. Orders are whole shares with cent prices; buys require enough available cash for their full limit quantity, sells require owned available inventory. Immediate remainders cancel, while resting limits survive same-hand poker revisions until filled, canceled, or settled. Settlement cancels open orders and redeems holdings.

## Forecast interpretation


After each poker event, 512 rollouts estimate expected main-pot contract payout under the style-based practice policies. Each simulated poker decision is made through its own private observation. Rollouts independently resample unknown future cards; they never inspect the real future deck. Practice traders interpret this estimate differently, react at different times, and manage finite inventories. In new Live games, Jev chooses bounded order actions using the spectator-visible cards, displayed showdown equity, market data, and visible trader holdings. The internal rollout estimates are not passed to Jev or used for its price candidates. It does not receive the undealt deck or RNG state.

These forecasts are a behavior surrogate for live LLMs, not a measured calibration of GPT, Claude, Gemini, or Grok. At 512 samples, a single binary probability has worst-case Monte Carlo standard error around 2.2 percentage points; policy error is additional. Tests include exact fixtures and convergence toward 4,096-sample references. Live calibration, held-out probability scoring, and richer trader policies are future work.

The displayed **showdown equity** is a separate card calculation: expected main-pot share if no remaining player folds. All dealt hole cards, including folded dead cards, are removed from possible runouts. Flop, turn, and river enumerate every possible remaining board; preflop uses 4,096 deterministic Monte Carlo samples seeded only by visible cards (worst-case standard error 0.78 percentage points). Ties split equity; settled hands display actual payouts. Results cache by visible cards and eligibility, never by the secret future deck.

The four-line percentage chart plots real book midpoints, or the latest trade when a two-sided quote is unavailable. It preserves missing-data gaps and resets with each hand. Folded outcomes mark at zero immediately, including the current endpoint of older snapshots; actual last executions stay intact. Earlier points retain their historical marks and tooltips label past snapshots. The visible CLOB shows executable bid/ask levels, quantities, and volume bars. These market prices can differ from card equity because the market also models future betting and folds.

Research and architecture notes: [Poker prediction market research and implementation spec](https://chatgpt.com/space/page_86bb73e8120481918fd9e90f936aace4).

## Live providers

The code defaults are defined in `lib/providers.ts`; exact model IDs are recorded in each session. Provider access must be verified in the deployment account. Override them with `POKER_MODEL_GPT`, `POKER_MODEL_CLAUDE`, `POKER_MODEL_GEMINI`, and `POKER_MODEL_GROK` before starting a new run.

Store `AI_GATEWAY_API_KEY` as a Sites runtime secret. Local development can use the ignored, owner-readable `.dev.vars`; never commit it. Copy the names from `.dev.vars.example`, not credentials into source. `LIVE_MODELS_READY=true` enables live starts only after provider verification. Practice runs remain usable without a key. Never silently substitute practice decisions in a live run; an upstream failure pauses the same poker state for retry or End run.

Gateway budgets and key expiry depend on the deployment configuration. Each account can start at most six live runs per rolling day. Each live run durably reserves at most 320 poker-provider attempts, including failures, with one correction attempt for an illegal action. New Live runs additionally allow up to 600 Jev market requests, including failed, stale, or interrupted attempts; these are separate from the poker allowance and share the Gateway billing budget. Billing verification and purchased-credit model eligibility are controlled by Vercel.

## Jev market traders

New **Live** games use `typesafe-ai/jev` through Vercel AI Gateway's documented [`POST /v1/evaluate`](https://vercel.com/docs/ai-gateway/modalities/decision) endpoint. The existing server-side `AI_GATEWAY_API_KEY` is used; no new SDK or provider key is needed. `LIVE_MODELS_READY=true` should only be enabled after verifying both poker providers and Jev access. Practice and legacy sessions created before Jev integration use local strategies. Saved Jev sessions retain Jev across hands.

- One request batches 16 independent typed Choice questions, at most once every three seconds while play is active. Makers choose responsive tight/wide quotes, market-only quotes, or hold; other strategies choose a buy/sell outcome and small preset size, or hold. Responsive maker candidates blend 75% displayed showdown equity with 25% normalized visible book marks so newly revealed cards can reprice quotes without exhausting the book first. The market-only choice retains existing visible references. Directional candidates use displayed best asks/bids, or a neutral equal price across non-folded players when quotes are unavailable. Eligibility depends on visible folds, not internal simulation probabilities. Jev chooses the action; it does not directly mutate the exchange or invent arbitrary orders.
- Each trader retains its strategy instructions and inventory. The matching engine rechecks funding and owned shares against the latest state, preserves human orders, prevents self-trades, and handles settlement. Quote updates expire after 12 active market seconds; hold retains existing orders until filled or expired. New Jev hands begin without locally seeded quotes or trades and populate after the first successful market poll.
- Model calls happen outside the database transaction and poker lease. A persisted reservation prevents duplicate polls from issuing concurrent Jev calls. Unexpired limit choices can still arrive after a same-hand poker action, with their original prices and current funding/fold checks. Results for another hand, expired requests, or paused games are discarded. Human trading and poker decisions can continue while Jev responds.
- An eight-second request timeout and a separate 600-request game cap bound attempts. Failure is visible beside the order book; existing orders remain until filled or expired. There is **no automatic local-bot fallback** in Jev games. Pause stops market requests and invalidates pending decisions; replay never calls Jev.
- The context follows the spectator UI: every revealed hole card, board, pot, turn/dealer, stacks/actions, personality tooltips, displayed showdown equity, aggregated top-six book levels, plotted price history, the latest six fills, visible trader holdings/net trades/order counts, spectator balances/positions/open orders, and the last ten activity entries. An explicit field allowlist excludes the undealt deck, seed, RNG, internal rollout forecasts, trader biases/beliefs/private cash/cost basis, user identity, and credentials. Market prices remain distinct from showdown equity.

Information-boundary tests change unseen forecasts, private trader cash/biases, deck order, and RNG while holding the visible state fixed; both model context and candidate menus must remain identical. Mocked adapter and service tests cover batch validation, missing/invalid answers, failures, call limits, duplicate requests, human fills during a Jev call, stale poker state, pause/resume, and funded settlement. No paid Jev request was made during implementation; deployment credentials, account eligibility, actual model quality, and live latency remain to be verified in a controlled Live run.

## Completed-game replays


Open **Your Games** to find your completed five-hand challenges, including practice/live and ranked/unranked games. **Replay** opens paused. Press **Play replay** to autoplay, step backward/forward, jump to a hand, or scrub the timeline. Speeds are Normal (2 seconds per saved step), Fast (1 second), and Slow (4 seconds). Playback uses saved table, market, account, and trader snapshots, makes no model calls, and cannot trade or change scores. A Replay game button also appears on the final-result screen.

Recordings begin with new challenges after the replay migration is installed. Games started before recording existed remain in history with replay unavailable. Guest history belongs to the current guest cookie; signed-in history belongs to the signed-in account. Replay endpoints require ownership and a completed challenge. Leaderboard replays are not exposed yet.

`replay_frames` stores only public views, excluding deck order, seeds, and private model inputs. The initial deal and successful poker actions, orders, cancellations, and resting-order fills are recorded atomically with session state. Ticks record a replay frame when observable book depth, the human account, or human orders change, including Jev-only quote updates. Unchanged ticks do not add frames. The historical book shows the top six recorded price levels per side for the selected model; earlier recordings remain limited to the snapshots they already contain. History is paginated in groups of 25.

Apply the generated replay migration to the local database after building, using [Local D1 migrations](development.md#local-d1-migrations). Production needs the same migration before serving the new API. `node scripts/smoke-api.mjs` verifies the full recording, owner-only access, idempotent retries, and unchanged scores after playback reads.

## Visual direction


The minimal interface uses one near-white surface, dark typography, aligned numerical rows, and restrained separators. Player groups and market data are unframed; playing cards are the main tactile elements. Color identifies card suits, chart series, and PnL rather than decorating containers. Text states, keyboard focus, class descriptions, and labelled trading controls remain explicit. The selected outcome’s showdown equity sits beside its price; longer explanations live in disclosures.

References: [Linear’s 2026 interface refresh](https://linear.app/now/behind-the-latest-design-refresh), [Vitsœ’s good design principles](https://www.vitsoe.com/rw/about/good-design), and [GOV.UK’s table guidance](https://design-system.service.gov.uk/components/table/).
