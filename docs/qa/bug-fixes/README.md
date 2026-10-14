# VESPER bug-fix recordings

Recorded on 2026-10-14. Each of the eight code PRs links to one before/after pair below. This evidence branch contains no application changes and does not need a PR or merge.

## Method and limits

- **Before:** main commit `b62b18b89f5d09075064ceb46678a1bb4ca90b35`.
- **After:** the integrated eight-fix stack at `33ee44f6fa2c5ab286cfc4ed485bfa76c0a5a9ab`. These are integration recordings, not claims that each clip was captured on its individual PR branch. Each PR diff contains its one bug fix; merge the stack in order.
- Actual application components, styling, poker rules, order matching, balances, and receipts run locally. An in-memory fixture server supplies seeded starting states and prescribed legal poker decisions. Later market forecasts retain the engine's randomness. Authentication is a fixture account. No live providers, production data, leaderboard attempts, or real funds are used.
- The first order in case 4 intentionally receives a stale-hand HTTP 409 so the error lifetime can be reproduced reliably. Case 8 starts at an engine-settled five-hand completion state. Case 1 advances the logical clock by 250 ms per poker action to exercise subsecond scheduling.
- The browser was operated through computer-use controls. MP4s consist of successive actual browser screenshots, sampled approximately 3–4 times per second and encoded using capture timestamps; no UI states or transitions were synthesized. The persistent caption identifies local regression footage. Videos are silent.
- `manifest.json` records source commits, checksums, frame counts, and DOM results captured during the interaction. No secrets or production account identities are included.

## Before and after

| Bug | Interaction and result | Before | After |
| --- | --- | --- | --- |
| 1. Realtime market freeze | Select Realtime, press Play, and watch streets plus the market chart. Baseline hand 1 stays at 0 seconds and 84 traded shares; fixed hand 1 reaches 4 seconds and 1,313 traded shares with changing quotes. The clip continues into hand 2, where the hand clock resets normally. | [MP4](01-before.mp4) | [MP4](01-after.mp4) |
| 2. Stale resting receipt | Hold 10 Claude shares, submit a resting sell of 5 at 29¢, and let a funded synthetic buyer match it. Both versions update holdings to 5 and cash to $998.95. Before retains No fill; after says 5 sold, $1.45 received, and zero remaining. | [MP4](02-before.mp4) | [MP4](02-after.mp4) |
| 3. Wrong quote side | Start with Buy selected, click Claude's Sell quote, then Gemini's Buy quote. After selects the corresponding side and price each time. | [MP4](03-before.mp4) | [MP4](03-after.mp4) |
| 4. Vanishing trade error | Submit the order that receives the documented 409, then allow automatic poker progression. Before clears the error; after preserves it until explicit dismissal. | [MP4](04-before.mp4) | [MP4](04-after.mp4) |
| 5. Folded holdings | Select Claude after its legal fold while holding 10 shares. After keeps Folded alongside ownership, explains the $0 payout, and disables the order ticket. | [MP4](05-before.mp4) | [MP4](05-after.mp4) |
| 6. Invalid drafts | Enter -1 and 1.5 shares, then 25 shares with an invalid 0¢ limit. After suppresses financial previews and disables submission; changing to 40¢ clears validation and shows the correct $10 maximum cost. | [MP4](06-before.mp4) | [MP4](06-after.mp4) |
| 7. Keep playing | Start playback, choose End run, then Keep playing. After resumes the running game. The after clip also verifies an initially paused game stays paused. | [MP4](07-before.mp4) | [MP4](07-after.mp4) |
| 8. Signed-in completion | Inspect a completed unranked challenge with a signed-in fixture profile. After gives the appropriate ranked-play guidance rather than asking the user to sign in. | [MP4](08-before.mp4) | [MP4](08-after.mp4) |

## Validation

The integrated stack passed all **144 Node tests**, TypeScript (`tsc --noEmit --incremental false`), `git diff --check`, and `npm run build`. Targeted changed ticket/helper files passed ESLint. The existing page `initialize()` effect lint error and avatar-image warning reproduce on the unmodified baseline and are outside these fixes.

Automated engine regressions cover fractional tick accumulation, pause/resume, bounded funded reactions, delayed Jev responses within the same hand, newly folded outcomes, expiry and hand transitions, no local fallback for Jev, delayed/partial/full receipts, actual Jev matching, cancellation races, invalid order drafts, and completion guidance variants. No real provider API call was made during this verification.
