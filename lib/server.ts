import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { GameError, commandGame, createGame, preparePokerDecision, viewGame } from "./game";
import type { Game, PreparedPokerDecision } from "./game";
import { createReplayFrame, shouldRecordReplay } from "./replay";
import { DEFAULT_MODELS, ProviderError, requestDecision } from "./providers";
import { prepareMarketRound, reserveMarketRound, finishMarketRound, requestMarketDecisions } from "./market-agents";
import { PROVIDERS } from "./poker";
import type { Bootstrap, CommandRequest, GameMode, LeaderboardEntry, Profile, SessionView, GameHistory, GameReplay, ReplayFrame } from "../app/types";
import { z } from "zod";

type Identity = { id: string; authenticated: boolean };
type SessionRow = { id: string; user_id: string; state: string; status: string; version: number; lock_until: number; lock_token: string | null; week: string; ranked: number; mode: GameMode; updated_at: number };
const uuid = z.string().uuid();
const commandSchema = z.intersection(z.object({requestId: uuid}), z.discriminatedUnion("type", [
  z.object({type: z.literal("advance"), pokerRevision: z.number().int().nonnegative()}),
  z.object({type: z.literal("next_hand"), pokerRevision: z.number().int().nonnegative()}),
  z.object({type: z.literal("tick")}),
  z.object({type: z.literal("playback"), paused: z.boolean()}),
  z.object({type: z.literal("cancel"), hand: z.number().int().min(1).max(5).optional(), pokerRevision:z.number().int().nonnegative(), orderId: z.string().min(1).max(100)}),
  z.object({type: z.literal("order"), hand: z.number().int().min(1).max(5).optional(), pokerRevision:z.number().int().nonnegative(), outcome: z.number().int().min(0).max(3), side: z.enum(["buy","sell"]), quantity: z.number().int().min(1).max(100000), limitPrice: z.number().min(.01).max(.99), orderType: z.enum(["ioc","limit"])}),
]));
function db() { if (!env.DB) throw new GameError("Game storage is temporarily unavailable.", 503); return env.DB; }
export function weekWindow(now = Date.now()) {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return {week: day.toISOString().slice(0, 10), nextReset: new Date(+day + 7 * 86400000).toISOString()};
}
export async function identity(): Promise<Identity> {
  const user = await getChatGPTUser();
  if (user) return {id: user.userId, authenticated: true};
  const jar = await cookies();
  let id = jar.get("river_guest")?.value;
  if (!id || !uuid.safeParse(id).success) {
    id = crypto.randomUUID();
    jar.set("river_guest", id, {httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30});
  }
  return {id: `guest:${id}`, authenticated: false};
}
export function modelIds() { return [env.POKER_MODEL_GPT, env.POKER_MODEL_CLAUDE, env.POKER_MODEL_GEMINI, env.POKER_MODEL_GROK].map((id, i) => id || DEFAULT_MODELS[i]); }
function liveReady() {return !!env.AI_GATEWAY_API_KEY && env.LIVE_MODELS_READY==="true";}
async function profileFor(id: string): Promise<Profile | null> {
  const row = await db().prepare("SELECT username FROM profiles WHERE user_id = ?").bind(id).first<{username:string}>();
  if (!row) return null;
  const count = await db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND week = ? AND ranked = 1").bind(id, weekWindow().week).first<{n:number}>();
  const starts = count?.n ?? 0;
  return {username: row.username, rankedStarts: starts, remainingAttempts: Math.max(0, 3 - starts)};
}
async function board(mode: GameMode, id: string): Promise<LeaderboardEntry[]> {
  const rows = await db().prepare(`SELECT p.username, s.user_id, MAX(s.final_pnl) AS pnl, COUNT(*) AS completed_runs
    FROM sessions s JOIN profiles p ON p.user_id=s.user_id
    WHERE s.week=? AND s.mode=? AND s.status='complete' AND s.ranked=1 AND s.final_pnl IS NOT NULL
    GROUP BY s.user_id ORDER BY pnl DESC, MIN(s.updated_at) ASC, s.user_id ASC LIMIT 25`).bind(weekWindow().week, mode).all<{username:string;user_id:string;pnl:number;completed_runs:number}>();
  return rows.results.map((r, i) => ({rank:i+1, username:r.username, pnl:r.pnl/120000, completedRuns:r.completed_runs, mode, isYou:r.user_id===id}));
}
async function activeRow(id: string) {
  return db().prepare("SELECT * FROM sessions WHERE user_id=? AND status IN ('playing','hand_complete') ORDER BY created_at DESC LIMIT 1").bind(id).first<SessionRow>();
}
export async function bootstrap(who: Identity, includeSession = false): Promise<Bootstrap> {
  const [profile, leaderboard, practiceLeaderboard, active] = await Promise.all([profileFor(who.id),board("live",who.id),board("practice",who.id),activeRow(who.id)]);
  return {authenticated:who.authenticated, profile, liveAvailable:liveReady(), liveUnavailableReason:liveReady() ? null : "Live model access is awaiting activation. Practice is ready to play.",
    models:modelIds().map((modelId,seat)=>({seat,name:PROVIDERS[seat],modelId})),
    leaderboard, practiceLeaderboard, ...weekWindow(), activeSessionId:active?.id??null,
    ...(includeSession ? { activeSession: active ? rowView(active) : null } : {})};
}
export async function saveProfile(who: Identity, body: unknown): Promise<Profile> {
  if (!who.authenticated) throw new GameError("Sign in to choose a leaderboard name.",401,"sign_in_required");
  const {username} = z.object({username:z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, "Use 3–20 letters, numbers, or underscores.")}).parse(body);
  try {
    await db().prepare("INSERT INTO profiles(user_id,username,username_key,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, username_key=excluded.username_key").bind(who.id,username,username.toLowerCase(),Date.now()).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new GameError("That username is taken. Try another.",409,"username_taken");
    throw error;
  }
  return (await profileFor(who.id))!;
}
function rowView(row: SessionRow): SessionView { return viewGame(JSON.parse(row.state) as Game, row.lock_until>Date.now()); }
async function ownedRow(id: string, who: Identity): Promise<SessionRow> {
  if (!uuid.safeParse(id).success) throw new GameError("Game not found.",404);
  const row = await db().prepare("SELECT * FROM sessions WHERE id=? AND user_id=?").bind(id,who.id).first<SessionRow>();
  if (!row) throw new GameError("Game not found.",404);
  return row;
}
export async function getSession(who: Identity, id?: string) {
  if (id) return rowView(await ownedRow(id, who));
  const row = await activeRow(who.id);
  return row ? rowView(row) : null;
}
export async function completedGames(who: Identity, page: number): Promise<GameHistory> {
  const rows = await db().prepare("SELECT * FROM sessions WHERE user_id=? AND status='complete' ORDER BY updated_at DESC,id DESC LIMIT 26 OFFSET ?")
    .bind(who.id, page * 25).all<SessionRow>();
  return {
    games: rows.results.slice(0, 25).map(row => {
      const game = JSON.parse(row.state) as Game;
      return { id: row.id, mode: row.mode, ranked: Boolean(row.ranked), pnl: viewGame(game).pnl,
        completedAt: new Date(row.updated_at).toISOString(), replayAvailable: game.replayVersion === 1 };
    }),
    nextPage: rows.results.length > 25 ? page + 1 : null,
  };
}
export async function getReplay(who: Identity, id: string): Promise<GameReplay> {
  const row = await ownedRow(id, who);
  if (row.status !== "complete") throw new GameError("Replay is available after all five hands finish.", 409, "not_complete");
  if ((JSON.parse(row.state) as Game).replayVersion !== 1)
    throw new GameError("This game started before replay recording was available.", 409, "replay_unavailable");
  const rows = await db().prepare("SELECT frame FROM replay_frames WHERE session_id=? ORDER BY version")
    .bind(id).all<{frame: string}>();
  const frames = rows.results.map(row => JSON.parse(row.frame) as ReplayFrame);
  if (!frames.length || frames[0].version !== 0 || frames.at(-1)?.session.status !== "complete")
    throw new GameError("This game does not have a complete replay recording.", 409, "replay_unavailable");
  return { id, frames };
}
export async function startSession(who: Identity, body: unknown) {
  const {mode,ranked,personalitiesEnabled,requestId} = z.object({mode:z.enum(["practice","live"]),ranked:z.boolean().default(false),personalitiesEnabled:z.boolean().default(false),requestId:uuid}).parse(body);
  const previous = await db().prepare("SELECT * FROM sessions WHERE id=? AND user_id=?").bind(requestId,who.id).first<SessionRow>();
  if (previous) return rowView(previous);
  const active = await activeRow(who.id); if (active) return rowView(active);
  if (mode==="live" && !who.authenticated) throw new GameError("Sign in to play with live models.",401,"sign_in_required");
  if (mode==="live" && !liveReady()) throw new GameError("Live models are awaiting activation. Practice is ready.",503,"provider_unavailable");
  if (ranked) {
    const profile = who.authenticated ? await profileFor(who.id) : null;
    if (!profile) throw new GameError("Sign in and choose a username before a ranked run.",401,"profile_required");
    if (!profile.remainingAttempts) throw new GameError("Your three ranked starts are used for this week. You can still play unranked.",409,"attempts_exhausted");
  }
  const now=Date.now(), week=weekWindow(now).week;
  const game=createGame(requestId,mode,ranked,now,modelIds(),personalitiesEnabled,mode === "live" ? "jev" : "local");
  const state = JSON.stringify(game);
  const [result] = await db().batch([db().prepare(`INSERT INTO sessions(id,user_id,week,mode,ranked,status,version,state,created_at,updated_at,lock_until)
    SELECT ?,?,?,?,?, 'playing',0,?,?,?,0
    WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE user_id=? AND status IN ('playing','hand_complete'))
    AND (?=0 OR (SELECT COUNT(*) FROM sessions WHERE user_id=? AND week=? AND ranked=1)<3)`)
    .bind(requestId,who.id,week,mode,ranked?1:0,state,now,now,who.id,ranked?1:0,who.id,week),
    db().prepare("INSERT INTO replay_frames(session_id,version,frame) SELECT ?,0,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND version=0 AND state=?)")
      .bind(requestId, JSON.stringify(createReplayFrame(game, "deal", now)), requestId, who.id, state),
  ]);
  if (!result.meta.changes) {
    const existing=await activeRow(who.id); if(existing) return rowView(existing);
    throw new GameError("No ranked starts remain for this week.",409);
  }
  return viewGame(game);
}
type PokerLease = { token: string; pokerRevision: number; hand: number; decision?: PreparedPokerDecision };

/** Market commits preserve any pending poker lease and retry only the short state transaction. */
async function saveCommand(who: Identity, id: string, command: CommandRequest, lease?: PokerLease): Promise<SessionView> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await ownedRow(id, who);
    if (row.status === "abandoned") throw new GameError("This run has ended. Start a new run.",409,"run_ended");
    const original = JSON.parse(row.state) as Game;
    if (original.requestIds.includes(command.requestId)) return rowView(row);
    const now = Date.now();
    if (lease && (row.lock_token !== lease.token || row.lock_until <= now || original.hand !== lease.hand || original.poker.revision !== lease.pokerRevision))
      throw new GameError("The table changed while the decision was running. Refresh to continue.",409,"stale_state");
    if (original.requestIds.length >= 10000 && command.type !== "tick") throw new GameError("This run has reached its action limit.",429);
    const game = await commandGame(original, command, now, undefined, lease?.decision);
    game.version = row.version + 1;
    if (command.type !== "tick") game.requestIds = [...game.requestIds, command.requestId];
    if (row.week !== weekWindow().week) { game.rankEligible = false; game.notice = "This run crossed the weekly reset and is no longer eligible for the leaderboard."; }
    const view = viewGame(game, !lease && row.lock_until > now), completed = view.status === "complete";
    const score = completed && game.rankEligible ? Math.round(view.pnl * 120000) : null;
    const state = JSON.stringify(game);
    const update = lease
      ? db().prepare("UPDATE sessions SET state=?,status=?,version=?,updated_at=?,final_pnl=?,lock_token=NULL,lock_until=0 WHERE id=? AND user_id=? AND version=? AND lock_token=? AND lock_until>? AND status!='abandoned'")
        .bind(state,view.status,game.version,now,score,id,who.id,row.version,lease.token,now)
      : db().prepare("UPDATE sessions SET state=?,status=?,version=?,updated_at=?,final_pnl=? WHERE id=? AND user_id=? AND version=? AND status!='abandoned'")
        .bind(state,view.status,game.version,now,score,id,who.id,row.version);
    const statements = [update];
    if (game.replayVersion === 1 && shouldRecordReplay(original,game,command.type)) {
      statements.push(db().prepare("INSERT INTO replay_frames(session_id,version,frame) SELECT ?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND version=? AND state=?)")
        .bind(id,game.version,JSON.stringify(createReplayFrame(game,command.type,now)),id,who.id,game.version,state));
    }
    // A losing compare-and-swap records no frame; the state and frame remain atomic.
    const [saved] = await db().batch(statements);
    if (saved.meta.changes) return view;
  }
  throw new GameError("The market is updating. Try this order again.",409,"busy");
}

/** Short optimistic transactions never hold the poker lease across a Jev request. */
async function saveAgentMutation(who: Identity, id: string, mutate: (game: Game, now: number) => Game | null): Promise<Game | null> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await ownedRow(id, who);
    if (row.status === "abandoned") return null;
    const original = JSON.parse(row.state) as Game, now = Date.now();
    const game = mutate(original, now);
    if (!game) return null;
    game.version = row.version + 1;
    const state = JSON.stringify(game);
    const statements = [db().prepare("UPDATE sessions SET state=?,version=?,updated_at=? WHERE id=? AND user_id=? AND version=? AND status!='abandoned'")
      .bind(state,game.version,now,id,who.id,row.version)];
    if (game.replayVersion === 1 && shouldRecordReplay(original,game,"tick")) {
      statements.push(db().prepare("INSERT INTO replay_frames(session_id,version,frame) SELECT ?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND user_id=? AND version=? AND state=?)")
        .bind(id,game.version,JSON.stringify(createReplayFrame(game,"tick",now)),id,who.id,game.version,state));
    }
    const [saved] = await db().batch(statements);
    if (saved.meta.changes) return game;
  }
  throw new GameError("The market is updating. Try again shortly.",409,"busy");
}

async function runMarketAgents(who: Identity, id: string): Promise<SessionView> {
  const token = crypto.randomUUID();
  const reserved = await saveAgentMutation(who,id,(game,now) => reserveMarketRound(game,token,now));
  if (!reserved) return rowView(await ownedRow(id,who));
  const round = prepareMarketRound(reserved);
  let answers: Awaited<ReturnType<typeof requestMarketDecisions>> | null = null;
  try {
    if (env.AI_GATEWAY_API_KEY && liveReady()) answers = await requestMarketDecisions(round,env.AI_GATEWAY_API_KEY);
  } catch {
    // Do not expose provider response bodies or substitute local decisions in a Jev game.
  }
  await saveAgentMutation(who,id,(game,now) => finishMarketRound(game,token,round,answers,now));
  return rowView(await ownedRow(id,who));
}

export async function executeCommand(who: Identity, id: string, body: unknown) {
  const command = commandSchema.parse(body) as CommandRequest;
  if (command.type !== "advance" && command.type !== "next_hand") {
    const view = await saveCommand(who,id,command);
    return command.type === "tick" ? runMarketAgents(who,id) : view;
  }
  const token = crypto.randomUUID();
  let original: Game | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await ownedRow(id,who);
    if (row.status === "abandoned") throw new GameError("This run has ended. Start a new run.",409,"run_ended");
    const game = JSON.parse(row.state) as Game;
    if (game.requestIds.includes(command.requestId)) return rowView(row);
    if (game.requestIds.length >= 10000) throw new GameError("This run has reached its action limit.",429);
    if (game.pausedAt !== undefined) throw new GameError("The game is paused. Press Play to continue trading and gameplay.",409,"GAME_PAUSED");
    if (command.pokerRevision !== game.poker.revision) throw new GameError("The table has advanced.",409,"stale_state");
    const now = Date.now();
    if (row.lock_until > now) throw new GameError("Another poker action is finishing.",409,"busy");
    const acquired = await db().prepare("UPDATE sessions SET lock_token=?,lock_until=? WHERE id=? AND user_id=? AND version=? AND lock_until<? AND status!='abandoned'")
      .bind(token,now+55000,id,who.id,row.version,now).run();
    if (acquired.meta.changes) { original = game; break; }
  }
  if (!original) throw new GameError("The table is updating. Try again.",409,"busy");
  try {
    const lease: PokerLease = { token, pokerRevision: original.poker.revision, hand: original.hand };
    if (command.type === "advance") {
      if (original.mode === "live") {
        if (!liveReady()) throw new GameError("Live model access is awaiting activation.",503,"provider_unavailable");
        // Reserve both possible provider attempts durably, even when a request fails.
        const budget = await db().prepare("UPDATE sessions SET provider_calls=provider_calls+2 WHERE id=? AND lock_token=? AND provider_calls<=318").bind(id,token).run();
        if (!budget.meta.changes) throw new GameError("This run has used its model-call allowance.",429,"call_limit");
      }
      lease.decision = await preparePokerDecision(original, env.AI_GATEWAY_API_KEY ? (obs,model,feedback) => requestDecision(obs,model,env.AI_GATEWAY_API_KEY!,feedback) : undefined);
    }
    // Apply the already-chosen action to the latest market, preserving concurrent trades.
    return await saveCommand(who,id,command,lease);
  } finally {
    await db().prepare("UPDATE sessions SET lock_token=NULL,lock_until=0 WHERE id=? AND lock_token=?").bind(id,token).run();
  }
}
export async function endSession(who:Identity,id:string) {
  await ownedRow(id,who);
  const result=await db().prepare("UPDATE sessions SET status='abandoned',version=version+1,updated_at=? WHERE id=? AND user_id=? AND status IN ('playing','hand_complete') AND lock_until<?").bind(Date.now(),id,who.id,Date.now()).run();
  if(!result.meta.changes) throw new GameError("An action is finishing or this run has already ended.",409,"busy");
  return {ok:true};
}
export function requireSameOrigin(request: Request) {
  const origin=request.headers.get("origin");
  if (!origin || origin!==new URL(request.url).origin) throw new GameError("This request must come from the game page.",403);
  if (!(request.headers.get("content-type")??"").startsWith("application/json")) throw new GameError("Expected a JSON request.",415);
  if (Number(request.headers.get("content-length")??0)>8192) throw new GameError("Request is too large.",413);
}
export async function readBody(request: Request) {
  requireSameOrigin(request);
  const text=await request.text(); if(text.length>8192) throw new GameError("Request is too large.",413);
  try {return JSON.parse(text);} catch {throw new GameError("Invalid JSON request.");}
}
export async function api(work:()=>Promise<unknown>):Promise<Response> {
  try {return Response.json(await work(),{headers:{"cache-control":"no-store"}});}
  catch(error) {
    const known=error instanceof GameError || error instanceof ProviderError || error instanceof z.ZodError;
    const message=error instanceof z.ZodError ? error.issues[0]?.message??"Invalid request." : known ? error.message : "The game could not finish this request. Please retry.";
    return Response.json({error:message,code:error instanceof GameError ? error.code : error instanceof ProviderError ? "provider_error" : "request_failed"},{status:error instanceof GameError ? error.status : error instanceof ProviderError ? 502 : error instanceof z.ZodError ? 400 : 500,headers:{"cache-control":"no-store"}});
  }
}
