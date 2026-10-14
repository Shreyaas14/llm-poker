# VESPER

A play-money prediction market around four AI poker players. The human watches all dealt cards and trades outcome shares; the human never occupies a poker seat. Built with React, TypeScript, Vinext, Cloudflare D1, and Sites authentication/hosting.

## Visual direction

The minimal interface uses one near-white surface, dark typography, aligned numerical rows, and restrained separators. Player groups and market data are unframed; playing cards are the main tactile elements. Color identifies card suits, chart series, and PnL rather than decorating containers. Text states, keyboard focus, class descriptions, and labelled trading controls remain explicit. The selected outcome’s showdown equity sits beside its price; longer explanations live in disclosures.

References: [Linear’s 2026 interface refresh](https://linear.app/now/behind-the-latest-design-refresh), [Vitsœ’s good design principles](https://www.vitsoe.com/rw/about/good-design), and [GOV.UK’s table guidance](https://design-system.service.gov.uk/components/table/).

## Game and market

- Five independent four-seat no-limit Texas Hold'em hands; 1,000 poker chips per seat, rotating dealer, 5/10 blinds. The human starts with $1,000 in play money and carries settled cash between hands.
- Each model sees only its own hole cards, public action history, board, and legal actions. The server deals from a secret 256-bit seed and validates every action. No model has tools or direct state access.
- Personalities are opt-in through the unchecked **Enable personalities** checkbox before a challenge starts. Without them, live models receive no assigned style and practice/forecast decisions use one neutral policy. When enabled, four poker personalities—Shark (selective, aggressive value betting), Bully (wide ranges and pressure), Maniac (frequent bluffs and large bets), and Opportunist (cheap-pot steals, cautious against resistance)—are randomly shuffled across the providers for each new challenge and persist across all five hands. The assigned class drives live prompts, practice decisions, and forecast rollouts. The choice persists across reloads and all five hands. Legacy saved sessions keep their original assignments. Class badges provide a short hover, focus, or tap description.
- The spectator and synthetic market traders know all dealt hole cards. Future board cards and shuffle seeds remain server-only.
- Sixteen funded traders place real limit orders into four books. Trades use price-time priority, partial fills, reserved cash/shares, and finite depth. New prices come from orders and executions, not a chart script. Human orders are bound to their hand and maximum buy/minimum sell price, so poker actions and quote changes do not invalidate same-hand orders. The trade ticket holds its price limit while edited and requires review after a hand change.
- The trader panel shows actual holdings and net filled shares for all 16 synthetic traders, plus named buyer/seller executions. Opening complete-set inventories (700 shares per outcome for makers, 240 for other traders) are distinguished from purchases. Quotes and open orders do not change holdings until matched; settlement redeems holdings.
- Each contract pays 1 credit for the sole main-pot winner, 1/k for each of k tied main-pot winners, and 0 otherwise. Side pots do not determine contracts. Fully collateralized complete sets back every share; integer settlement units preserve thirds exactly.
- New games advance automatically after 6 seconds (Normal) or 3 seconds (Fast), with a four-second settlement pause between hands. Normal is the default. Realtime starts the next action or hand as soon as the previous response and state save finish, without an added pause. Model response time, game calculations, networking, and persistence determine its actual speed. A single Play/Pause control manages the game and market. Entering/submitting trades and rejected orders leave playback running without resetting its countdown. Navigation, hidden tabs, and poker/model errors pause play; reopened sessions start paused. A model request already in flight completes before pausing.
- Human trading stays open until the hand settles, including while a model is deciding. Market commands commit independently of the pending poker decision; the decision applies to the latest market so concurrent fills are preserved. Synthetic quote arrivals remain bounded to 45 active seconds after each poker action. A server-persisted pause freezes its remaining time and blocks orders, cancellations, poker actions, and synthetic fills. Play resumes the same remaining window; repeated toggles do not replenish it. Orders can rest across poker actions, and are cancelled at settlement.
- Final PnL is settled cash minus 1,000. Live account value walks available external bids; shares lacking bids are marked at zero. Quotes are executable prices, not guaranteed probabilities.
- Sign in with ChatGPT, choose a unique username, and opt into ranked play. The best completed score among the first three ranked starts counts each UTC week starting Monday. The three starts are shared across the separate practice/live boards. Abandoned runs consume a start. Prior weeks remain stored.

## Forecast interpretation

After each poker event, 512 rollouts estimate expected main-pot contract payout under the style-based practice policies. Each simulated poker decision is made through its own private observation. Rollouts independently resample unknown future cards; they never inspect the real future deck. Practice traders interpret this estimate differently, react at different times, and manage finite inventories. In new Live games, Jev chooses bounded order actions using these estimates, dealt cards, recent prices, strategy instructions, and funded inventories. It does not receive the undealt deck or RNG state.

These forecasts are a behavior surrogate for live LLMs, not a measured calibration of GPT, Claude, Gemini, or Grok. At 512 samples, a single binary probability has worst-case Monte Carlo standard error around 2.2 percentage points; policy error is additional. Tests include exact fixtures and convergence toward 4,096-sample references. Live calibration, held-out probability scoring, and richer trader policies are future work.

The displayed **showdown equity** is a separate card calculation: expected main-pot share if no remaining player folds. All dealt hole cards, including folded dead cards, are removed from possible runouts. Flop, turn, and river enumerate every possible remaining board; preflop uses 4,096 deterministic Monte Carlo samples seeded only by visible cards (worst-case standard error 0.78 percentage points). Ties split equity; settled hands display actual payouts. Results cache by visible cards and eligibility, never by the secret future deck.

The four-line percentage chart plots real book midpoints, or the latest trade when a two-sided quote is unavailable. It preserves missing-data gaps and resets with each hand. The visible CLOB shows executable bid/ask levels, quantities, and volume bars. These market prices can differ from card equity because the market also models future betting and folds.

Research and architecture notes: [Poker prediction market research and implementation spec](https://chatgpt.com/space/page_86bb73e8120481918fd9e90f936aace4).

## Live providers

The defaults in `lib/providers.ts` were checked against the Gateway catalog on 2026-10-13. Exact model IDs are recorded in each session. Override them with `POKER_MODEL_GPT`, `POKER_MODEL_CLAUDE`, `POKER_MODEL_GEMINI`, and `POKER_MODEL_GROK` before starting a new run.

Store `AI_GATEWAY_API_KEY` as a Sites runtime secret. Local development can use the ignored, owner-readable `.dev.vars`; never commit it. Copy the names from `.dev.vars.example`, not credentials into source. `LIVE_MODELS_READY=true` enables live starts only after provider verification. Practice runs remain usable without a key. Never silently substitute practice decisions in a live run; an upstream failure pauses the same poker state for retry or End run.

The approved demo key has a $5 nonrenewing budget and seven-day expiry. Each account can start at most six live runs per rolling day. Each live run durably reserves at most 320 poker-provider attempts, including failures, with one correction attempt for an illegal action. New Live runs additionally allow up to 600 Jev market requests, including failed, stale, or interrupted attempts; these are separate from the poker allowance and share the Gateway billing budget. Billing verification and purchased-credit model eligibility are controlled by Vercel.

## Jev market traders

New **Live** games use `typesafe-ai/jev` through Vercel AI Gateway's documented [`POST /v1/evaluate`](https://vercel.com/docs/ai-gateway/modalities/decision) endpoint. The existing server-side `AI_GATEWAY_API_KEY` is used; no new SDK or provider key is needed. `LIVE_MODELS_READY=true` should only be enabled after verifying both poker providers and Jev access. Practice and already-saved games keep their local trader engine, including across subsequent hands.

- One request batches 16 independent typed Choice questions, at most once every three seconds while play is active. Makers choose tight quotes, wide quotes, or hold; other strategies choose a buy/sell outcome and small preset size, or hold. Price candidates are derived by code from estimated payouts and each trader's fixed bias. Jev chooses the action; it does not directly mutate the exchange or invent arbitrary orders.
- Each trader retains its strategy instructions and inventory. The matching engine rechecks funding and owned shares against the latest state, preserves human orders, prevents self-trades, and handles settlement. Quote updates expire after 12 active market seconds; hold retains existing orders until filled or expired. New Jev hands begin without locally seeded quotes or trades and populate after the first successful market poll.
- Model calls happen outside the database transaction and poker lease. A persisted reservation prevents duplicate polls from issuing concurrent Jev calls. Results from changed poker revisions/hands, expired requests, or paused games are discarded. Human trading and poker decisions can continue while Jev responds.
- An eight-second request timeout and a separate 600-request game cap bound attempts. Failure is visible beside the order book; existing orders remain until filled or expired. There is **no automatic local-bot fallback** in Jev games. Pause stops market requests and invalidates pending decisions; replay never calls Jev.
- The context includes every dealt hole card (as seen by the human spectator), current board/actions, payout estimates, top recorded orders, recent prices, and synthetic inventories. It excludes the undealt deck, seed, RNG, human identity, and credentials. Market prices remain distinct from showdown equity.

Mocked adapter and service tests cover batch validation, missing/invalid answers, failures, call limits, duplicate requests, human fills during a Jev call, stale poker state, pause/resume, and funded settlement. No paid Jev request was made during implementation; deployment credentials, account eligibility, actual model quality, and live latency remain to be verified in a controlled Live run.

## Validation

```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.ts
npm run lint
node scripts/smoke-api.mjs
```

The API smoke script is restricted to localhost and requires the running preview and migrated local D1. It uses the preview-only sign-in identity, buys real shares, runs five hands, checks PnL and persistence, rejects cross-origin/stale/foreign-session requests, and verifies the weekly board. `RIVER_TEST_LIVE=1 node scripts/smoke-api.mjs` makes billed live calls: use only with explicit spend authorization. `scripts/check-poker-providers.mjs` verifies all four adapters against their real APIs and also incurs charges.

Unit tests cover rule edge cases, 500 randomized hands, independent ChaCha20 comparison, information boundaries, funded-book conservation, execution semantics, exact ties, five-hand cash carry, and provider failures. Browser QA covers desktop/mobile, partial fills, limits/cancellation, settlement, refresh/resume, expiry, and ending a run. Production access is private unless explicitly changed through Sites.

## Implementation map

| Path | Purpose |
| --- | --- |
| `lib/poker.ts` | Authoritative rules, evaluation, private observations, practice policies, forecasts |
| `lib/equity.ts` | Independent mathematical showdown equity and visible-state cache key |
| `lib/market.ts` | Funded exchange, synthetic traders, exact settlement ledger |
| `lib/game.ts` | Five-hand orchestration and safe spectator projection |
| `lib/providers.ts` | Server-only structured model decisions |
| `lib/server.ts` | Identity, D1 snapshots/locks/idempotency, account limits, weekly scores |
| `app/api/` | Validated JSON API |
| `components/river/` | Accessible card/table and trading views |
| `db/schema.ts`, `drizzle/` | Durable profiles, sessions, and immutable migrations |

## Maintained runtime notes

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` defines profiles and game sessions
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Completed-game replays

Open **Your games** to find your completed five-hand challenges, including practice/live and ranked/unranked games. **Replay** starts automatic playback immediately; pause, step backward/forward, jump to a hand, or scrub the timeline. Playback uses saved table, market, account, and trader snapshots, makes no model calls, and cannot trade or change scores. A Replay game button also appears on the final-result screen.

Recordings begin with new challenges after the replay migration is installed. Games started before recording existed remain in history with replay unavailable. Guest history belongs to the current guest cookie; signed-in history belongs to the signed-in account. Replay endpoints require ownership and a completed challenge. Leaderboard replays are not exposed yet.

`replay_frames` stores only public views, excluding deck order, seeds, and private model inputs. The initial deal and successful poker actions, orders, cancellations, and resting-order fills are recorded atomically with session state. Idle synthetic market ticks appear in the market chart at the next recorded action rather than adding empty playback steps. History is paginated in groups of 25.

Apply the generated replay migration to the local database after building, using the command in the migration section below. Production needs the same migration before serving the new API. `node scripts/smoke-api.mjs` verifies the full recording, owner-only access, idempotent retries, and unchanged scores after playback reads.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
