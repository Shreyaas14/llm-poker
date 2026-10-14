<p align="center"><img src="public/vesper-logo-transparent.png" alt="VESPER" width="180"></p>

# VESPER

**Watch four AI players play poker. Trade who wins.**

Start with **$1,000 in play money**, watch GPT, Claude, Gemini, and Grok play five hands of Texas Hold’em, and buy or sell shares in the outcome. You’re the spectator and trader; the models occupy the poker seats.

[How to Play](#how-to-play) · [Trading](#make-a-trade) · [Personalities](#choose-your-opponents-styles) · [Replay](#rewind-the-game) · [Run Locally](#run-locally)

<!-- DEMO_PLAY -->

*Real Practice gameplay at Fast speed: revealed cards, betting, changing quotes, and your positions. All demos use synthetic decisions and play money.*

## How to Play

1. **Start a Practice game** for instant local decisions, or choose **Live models** when provider access is enabled. Live play requires sign-in.
2. Optionally enable **personalities** before starting. Watch every dealt hole card; future community cards stay hidden until dealt.
3. Pick a player in **Who wins?**, choose Buy or Sell, set a share quantity, and submit an immediate or resting limit order.
4. Each hand settles against the **main-pot winners**. Your trading cash carries into the next hand; the four poker stacks reset.
5. After five hands, your score is **final cash minus $1,000**. Open **Replay Game** or start **Play Another Game**.

| Mode | Poker decisions | Market traders | Provider calls |
| --- | --- | --- | --- |
| Practice | Local decision policies | Local funded strategies | None |
| Live | GPT, Claude, Gemini, and Grok via Vercel AI Gateway | Jev chooses bounded trader actions | Billed when enabled |

Each hand uses four seats, 1,000-chip starting stacks, 5/10 blinds, and a rotating dealer. Contracts settle on the main pot; side-pot winners do not determine their payout.

All balances are play money. There are no deposits, withdrawals, or prizes.

## Make a Trade

<!-- DEMO_TRADE -->

*In this Practice example, 15 of 25 Claude shares fill at 82¢: $12.30 is paid and the 10-share remainder cancels. Holdings, available depth, and the order receipt update together.*

| Order | What happens |
| --- | --- |
| Buy / sell at displayed quote | Matches available orders within the displayed maximum buy or minimum sell price. Any unfilled quantity cancels. |
| Limit order | Matches immediately where possible; the remainder rests until filled, canceled, or the hand settles. |
| Sell | Sells shares you own. Shares reserved by another sell order are unavailable. |
| Cancel | Releases the unfilled order’s reserved cash or shares. Already executed fills remain final. |

Prices use whole-cent increments from **1¢ to 99¢**. Orders use whole shares, with an engine maximum of 100,000 shares, subject to available cash and owned inventory. Buys reserve enough cash for the entire quantity at your price limit. There is no borrowing or short selling.

For example, **25 shares bought at 40¢ cost $10**:

| Main-pot result | Redemption | Net result on those shares |
| --- | --- | --- |
| Your player wins alone | $25 | +$15 |
| Your player ties with one other winner | $12.50 | +$2.50 |
| Your player loses or folds | $0 | −$10 |

You can also sell before settlement at available bids. Paying a spread can produce an immediate unrealized loss even when the poker state hasn’t changed. A quoted price and a submitted order do not guarantee a fill: price limits, timing, funds, inventory, and available depth all matter.

## Read the Market

| In the app | Meaning |
| --- | --- |
| Buy | Best available ask: what a seller is asking per share. |
| Sell | Best available bid: what a buyer is offering per share. |
| Market chart and comparison | Bid–ask midpoint, or the last execution if a two-sided quote is missing. Folded outcomes mark at zero. These independent market marks need not sum to 100%. |
| Showdown equity | Mathematical expected main-pot share if the remaining players reach showdown without further folds. Ties split equity. |
| Available cash | Cash you can spend after resting buy-order reservations. |
| Account value | Cash plus the proceeds available by walking external bids for your shares. Shares without buyers are marked at zero. |

The order book shows aggregated price levels and available share quantities. In the live chart/book, **1% means 1¢ per share**; historical books show cents explicitly. Hover the chart to identify every player by name, or focus it and use the arrow keys. Earlier points are labeled **Historical**; they preserve the market at that time, including before a later fold.

**Sixteen synthetic traders** supply actual funded orders: makers, value, equity, momentum, contrarian, and noise strategies. Trades follow price-time priority, allow partial fills, and change real play-money holdings. Expand **Trader details** to inspect holdings or net filled shares; **Latest fills** names the buyer and seller. Opening collateral-backed inventory and settlement redemptions are distinct from purchases and sales.

In Live mode, responsive maker choices blend **75% displayed showdown equity and 25% visible market marks** so new cards can change offered prices. Jev can also retain market-based quotes or hold. That reference is a pricing heuristic, not the mathematical definition of the market price. All orders still pass funding, inventory, and matching checks.

## Choose Your Opponents’ Styles

Personalities are **off by default**. Enable them before starting to shuffle one of each style across the four model seats; assignments stay fixed for all five hands.

| Personality | Playing tendency |
| --- | --- |
| Shark | Selective hands and aggressive value betting. |
| Bully | Wide ranges and pressure on opponents. |
| Maniac | Frequent bluffs and large bets. |
| Opportunist | Cheap-pot steals, with caution against resistance. |

Hover or focus a class badge for its description. Styles influence Live prompts, Practice decisions, and Practice forecast rollouts; they are tendencies rather than guaranteed actions. With personalities disabled, there is no assigned style and Practice uses a neutral policy.

## Rewind the Game

<!-- DEMO_REPLAY -->

*Step through saved market depth and switch players to inspect their historical books. Replay reads recorded snapshots; it does not simulate new trades.*

Open **Your Games** to find completed Practice/Live and ranked/unranked challenges. Replays **open paused**. Play, pause, step backward or forward, jump to a hand, scrub the timeline, or choose Normal (2s), Fast (1s), or Slow (4s) playback.

You can inspect recorded cards, actions, account values, positions, trader holdings, and the top six book levels per side. Replay is read-only: it makes no model calls, cannot place orders, and cannot change scores. Quote/depth updates are recorded even when the human did not trade; unchanged ticks add no frame. Earlier games remain limited to the snapshots originally saved, and games predating recording may have no replay.

History is private to the owning account or guest cookie, paginated 25 games at a time. Only completed five-hand challenges can be replayed.

## Pace and Rankings

| Playback | Delay before the next poker action |
| --- | --- |
| Normal — default | 6 seconds |
| Fast | 3 seconds |
| Realtime | No added delay; calculation, provider response, and persistence still take time. |

Normal and Fast pause four seconds between hands; Realtime adds no settlement delay. **Pause** freezes poker and the market and disables orders/cancellations. Leaving the tab, navigating away, or reopening a saved run pauses play. Orders and cancellations can otherwise proceed while a model is deciding. Same-hand price limits survive poker actions; changing hands requires a fresh trade review. Synthetic quote arrivals stop after 45 active seconds without a new poker action.

For ranked play, sign in with ChatGPT and choose a username. Practice and Live have separate weekly boards but share **three ranked starts per UTC week**, resetting Monday. Your best eligible completed score counts. Starting and abandoning a ranked run still uses an attempt; crossing the weekly reset makes that run ineligible. You can end a run early, but it will not produce a completed score or replay.

## Run Locally

Requires **Node.js 22.13 or later**. The app uses React, TypeScript, Vinext, Cloudflare D1, and Sites hosting/authentication.

```sh
npm run install:ci
npm run build
```

Apply the existing pending migrations in order using the [local D1 migration instructions](docs/development.md#local-d1-migrations), then start the preview:

```sh
npm run dev
```

The portable preview starts at `http://127.0.0.1:5173/`. Practice works without model credentials. Local development offers a loopback-only simulated ChatGPT sign-in; hosted sign-in is handled by Sites.

For Live mode, configure the server-only variables in [`.dev.vars.example`](.dev.vars.example), verify provider access, and enable `LIVE_MODELS_READY=true`. Keep secrets out of Git. Current model IDs, overrides, request limits, and Jev setup are documented in [Market Mechanics](docs/market-mechanics.md#live-providers).

```sh
npx tsc --noEmit --incremental false
node --experimental-strip-types --test tests/*.test.ts
```

[Development and Sites hosting](docs/development.md) covers builds, migrations, authentication, and local smoke tests. [Market mechanics](docs/market-mechanics.md) explains settlement, pricing, information boundaries, and Live configuration. [Gameplay QA](docs/gameplay-ui-qa.md) records browser checks and known validation limits.
