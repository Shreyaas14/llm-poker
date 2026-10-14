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
