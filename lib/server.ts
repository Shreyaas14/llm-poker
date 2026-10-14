import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { GameError, commandGame, createGame, viewGame } from "./game";
import type { Game } from "./game";
import { DEFAULT_MODELS, ProviderError, requestDecision } from "./providers";
import { PROVIDERS } from "./poker";
import type { Bootstrap, CommandRequest, GameMode, LeaderboardEntry, Profile, SessionView } from "../app/types";
import { z } from "zod";

type Identity = { id: string; authenticated: boolean };
type SessionRow = { id: string; user_id: string; state: string; status: string; version: number; lock_until: number; week: string; ranked: number };
const uuid = z.string().uuid();
const commandSchema = z.intersection(z.object({requestId: uuid}), z.discriminatedUnion("type", [
  z.object({type: z.literal("advance"), pokerRevision: z.number().int().nonnegative()}),
  z.object({type: z.literal("next_hand"), pokerRevision: z.number().int().nonnegative()}),
  z.object({type: z.literal("tick")}),
  z.object({type: z.literal("cancel"), pokerRevision:z.number().int().nonnegative(), orderId: z.string().min(1).max(100)}),
  z.object({type: z.literal("order"), pokerRevision:z.number().int().nonnegative(), outcome: z.number().int().min(0).max(3), side: z.enum(["buy","sell"]), quantity: z.number().int().min(1).max(100000), limitPrice: z.number().min(.01).max(.99), orderType: z.enum(["ioc","limit"])}),
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
export async function bootstrap(who: Identity): Promise<Bootstrap> {
  const [profile, leaderboard, practiceLeaderboard, active] = await Promise.all([profileFor(who.id),board("live",who.id),board("practice",who.id),activeRow(who.id)]);
  return {authenticated:who.authenticated, profile, liveAvailable:liveReady(), liveUnavailableReason:liveReady() ? null : "Live model access is awaiting activation. Practice is ready to play.",
    models:modelIds().map((modelId,seat)=>({seat,name:PROVIDERS[seat],modelId})),
    leaderboard, practiceLeaderboard, ...weekWindow(), activeSessionId:active?.id??null};
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
export async function startSession(who: Identity, body: unknown) {
  const {mode,ranked,requestId} = z.object({mode:z.enum(["practice","live"]),ranked:z.boolean().default(false),requestId:uuid}).parse(body);
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
  // Limit billed runs per signed-in account in addition to the Gateway's global cap.
  if (mode==="live") {
    const count = await db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND mode='live' AND created_at>?").bind(who.id,Date.now()-86400000).first<{n:number}>();
    if ((count?.n??0)>=6) throw new GameError("Today's six live runs are used. Practice is still available.",429,"daily_limit");
  }
  const now=Date.now(), week=weekWindow(now).week;
  const game=createGame(requestId,mode,ranked,now,modelIds());
  const result=await db().prepare(`INSERT INTO sessions(id,user_id,week,mode,ranked,status,version,state,created_at,updated_at,lock_until)
    SELECT ?,?,?,?,?, 'playing',0,?,?,?,0
    WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE user_id=? AND status IN ('playing','hand_complete'))
    AND (?=0 OR (SELECT COUNT(*) FROM sessions WHERE user_id=? AND week=? AND ranked=1)<3)
    AND (?!='live' OR (SELECT COUNT(*) FROM sessions WHERE user_id=? AND mode='live' AND created_at>?)<6)`)
    .bind(requestId,who.id,week,mode,ranked?1:0,JSON.stringify(game),now,now,who.id,ranked?1:0,who.id,week,mode,who.id,now-86400000).run();
  if (!result.meta.changes) {
    const existing=await activeRow(who.id); if(existing) return rowView(existing);
    throw new GameError("No ranked starts remain for this week.",409);
  }
  return viewGame(game);
}
export async function executeCommand(who: Identity,id: string,body: unknown) {
  const command=commandSchema.parse(body) as CommandRequest;
  const row=await ownedRow(id,who);
  if(row.status==="abandoned") throw new GameError("This run has ended. Start a new run.",409,"run_ended");
  const original=JSON.parse(row.state) as Game;
  if (original.requestIds.includes(command.requestId)) return rowView(row);
  const now=Date.now(),token=crypto.randomUUID();
  const acquired=await db().prepare("UPDATE sessions SET lock_token=?,lock_until=? WHERE id=? AND user_id=? AND version=? AND lock_until<? AND status!='abandoned'")
    .bind(token,now+55000,id,who.id,row.version,now).run();
  if (!acquired.meta.changes) throw new GameError("Another action is finishing. Try again in a moment.",409,"busy");
  try {
    // Reserve both possible API attempts durably, including failed requests.
    if(original.mode==="live" && command.type==="advance") {
      if(!liveReady()) throw new GameError("Live model access is awaiting activation. You can end this run and play practice.",503,"provider_unavailable");
      if(command.pokerRevision!==original.poker.revision) throw new GameError("The table has advanced.",409,"stale_state");
      const budget=await db().prepare("UPDATE sessions SET provider_calls=provider_calls+2 WHERE id=? AND lock_token=? AND provider_calls<=318").bind(id,token).run();
      if(!budget.meta.changes) throw new GameError("This run has used its model-call allowance.",429,"call_limit");
    }
    if(original.requestIds.length>=10000 && command.type!=="tick") throw new GameError("This run has reached its action limit.",429);
    const game=await commandGame(original,command,now,env.AI_GATEWAY_API_KEY ? (obs,model,feedback)=>requestDecision(obs,model,env.AI_GATEWAY_API_KEY!,feedback) : undefined);
    game.version=row.version+1;
    if(command.type!=="tick") game.requestIds=[...game.requestIds,command.requestId];
    // A ranked run must finish in the week it started. Its gameplay remains available.
    if (row.week!==weekWindow().week) {game.rankEligible=false;game.notice="This run crossed the weekly reset and is no longer eligible for the leaderboard.";}
    const view=viewGame(game), completed=view.status==="complete";
    const score=completed && game.rankEligible ? Math.round(view.pnl*120000) : null;
    const saved=await db().prepare("UPDATE sessions SET state=?,status=?,version=?,updated_at=?,final_pnl=?,lock_token=NULL,lock_until=0 WHERE id=? AND lock_token=? AND version=?")
      .bind(JSON.stringify(game),view.status,game.version,Date.now(),score,id,token,row.version).run();
    if (!saved.meta.changes) throw new GameError("The game changed while this action was running. Reload to continue.",409,"stale_state");
    return view;
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
