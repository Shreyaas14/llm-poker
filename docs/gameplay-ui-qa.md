# Desktop gameplay UI QA

Compared the real local application against `main` at `d8db58c`. This change targets a quick desktop demo, with the existing personality opt-in and synthetic game rules unchanged.

## UI checks

- Switching between outcome books with different numbers of levels: baseline book height varied from 276px to 308px; the new book remained 316px high.
- First partial order: both takes bought 2 of 25 GPT shares at 58¢, paying 1.16 credits and canceling the remainder. With native clicks and unchanged scroll position, price locking moved the baseline submit button down 42px, and the order receipt moved the book another 70px (112px total). The new book and trade button stayed in place. The notification was visible and could be dismissed.
- Trader details: closed on initial render, with volume and latest fills visible. Opening the native disclosure revealed both position views and the full trader table; closing it returned to the summary. The section decreased from approximately 768px to 410px by default.
- Playback: checked pause, resume, normal and realtime play on desktop. Status text has a dedicated row, and the upstream continuous-trading queues remain intact. The playback GIF is an integration comparison, not a speed benchmark.
- Final result: cloned a paused fifth-hand database snapshot into both previews, then played the same final hand to completion. Both takes began with the same fifth-hand snapshot; practice decisions remain randomized, so the GIF compares placement rather than poker outcomes. The final summary now appears below the table rather than pushing it down.

Combined price-lock and quote availability messages into one stable note so focusing the ticket does not move its submit button. Removed the earlier large receipt slot and measured settlement-height reservation. Holding notices keep one short line rather than two; longer notices remain available through the text's native tooltip. The settlement ticket uses its natural content height.

## Evidence

Five labeled before/after GIFs cover playback, trading receipts, order-book depth, trader details, and final results. They consist of native screenshots from real UI actions and are attached to the PR rather than committed to Git. Source screenshots, comparison media, and database snapshots were generated outside the repository. Every GIF frame was inspected, and the animations were decoded before upload.

The recordings use local practice games with live models disabled. Initial game and final-hand snapshots were copied between isolated local databases to keep comparison data matched; no production database was involved. No LLM calls were made. Desktop widths of 1280px and 1105px were checked.

## Validation

```sh
node --experimental-strip-types --test tests/*.test.ts
npx tsc --noEmit --incremental false
npx eslint components/river/MarketPanel.tsx components/river/PositionsStrip.tsx components/river/TraderActivity.tsx
RIVER_TEST_LIVE=0 RIVER_TEST_RANKED=0 node scripts/smoke-api.mjs
npm run build
git diff --check
```

All 101 tests passed. TypeScript, changed-component lint, production build, and diff checks passed. The practice API smoke test completed five hands and verified trading, persistence, owner-only replay access, and unchanged results after replay reads.

Full `npm run lint` still reports the pre-existing `react-hooks/set-state-in-effect` error in `app/page.tsx:85` and the existing logo `<img>` warning. Both were reproduced against the unmodified `main` file during the initial QA.


## Jev Live traders follow-up

New Live sessions use Jev through Gateway; Practice and legacy sessions keep local strategies. The added adapter/market/service tests use mocked provider replies, with no billed calls. The complete suite now passes 115 tests. TypeScript, targeted lint, the production build, and a five-hand Practice API smoke test (64 poker actions, 139 replay steps) passed. Real Jev connectivity, decision quality, and latency have not been measured. See README's Jev market traders section for the bounded action menus, concurrency guards, and separate call budget.


## Historical order book replay follow-up

Verified in a real saved Practice replay at desktop size: replay opens paused; selecting Claude updates both the wider historical book and sidebar selection; Next moves from hand 1 at 0s to the recorded 4s snapshot; Previous restores the original prices/quantities; seeking the last step shows settled orders with guidance to step backward. New service coverage verifies a Jev-only quote update records a replay frame without any human trade. Older recordings remain limited to the snapshots already saved. No provider calls are made by replay.


## Jev spectator-view boundary follow-up

Jev now follows the spectator-visible information policy selected by the user: revealed hole cards, displayed showdown equity, visible market data, and visible trader holdings are included. Internal poker rollout forecasts, private trader cash/biases/cost basis, the seed, RNG, and undealt deck are excluded. Candidate prices use visible quotes or neutral opening prices, and eligibility comes from public folds. Regression tests perturb the excluded fields while holding displayed state fixed and require identical context and order menus; an adapter test checks the serialized Gateway payload. All 128 tests on the updated main baseline, TypeScript, targeted lint, and the production build passed. No paid model calls were made.


## Coherent probabilities and funded depth follow-up

Against main `d98c2cd`, the chart, keyboard tooltip, and comparison table now display normalized market probabilities totaling exactly 100% after rounding. Buy/Sell and the live and historical books retain actual quotes in cents. Browser checks at 1440 × 1000 confirmed a public fold displays 0%, with the other displayed probabilities totaling 100%, and the tooltip names all four outcomes. A separate deterministic fixture fills a 100-share buy at the displayed ask and verifies two funded makers provide 2,800 shares across six price levels per side at neutral prices. Real-game quantities vary with fills, funding, clamped price levels, and quote replenishment.

A five-hand Practice smoke test completed 49 actions and verified 105 replay steps, persistence, owner-only access, and replay immutability. Native UI replay checks restored opening depth on Previous, then showed an actual recorded purchase reducing the 2¢ ask from 160 to 158 shares. Screenshots of the real Practice UI and replay are attached to the follow-up PR outside Git history. All 138 tests, TypeScript, targeted lint, production build, and diff checks passed. Full lint retains the existing `app/page.tsx:85` initialization error and logo warning, reproduced against the unmodified main file. No paid model calls were made; Gateway tests use mocked responses. Real Jev quote selection, latency, and fill rates remain unmeasured.

New tests cover normalized/rounded probabilities, missing marks, public-fold history, coherent maker bounds, funded depth, complete-set buy/redeem and split/sell arbitrage, changing depth, incomplete baskets, reserved funds/inventory, legacy inventory metadata, net-fill accounting, collateral conservation, and tie settlement. Arbitrage is a separate deterministic participant in both modes, with no extra Jev question. New accounts have larger maker capital; existing saved accounts are not topped up. Unfilled limits remain possible and are not converted into synthetic executions.
