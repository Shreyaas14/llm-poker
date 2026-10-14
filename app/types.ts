import type { MarketView } from "../lib/market";

export type GameMode = "practice" | "live";
export type Profile = { username: string; rankedStarts: number; remainingAttempts: number };
export type ModelInfo = { seat: number; name: string; modelId: string };
export type LeaderboardEntry = { rank: number; username: string; pnl: number; completedRuns: number; mode: GameMode; isYou: boolean };
export type Bootstrap = {
  authenticated: boolean;
  profile: Profile | null;
  liveAvailable: boolean;
  liveUnavailableReason: string | null;
  models: ModelInfo[];
  leaderboard: LeaderboardEntry[];
  practiceLeaderboard: LeaderboardEntry[];
  week: string;
  nextReset: string;
  activeSessionId: string | null;
};
export type PlayerView = {
  seat: number; name: string; modelId: string; classId: string | null; className: string | null; description: string;
  stack: number; cards: string[]; bet: number; contributed: number;
  folded: boolean; allIn: boolean; lastAction: string;
};
export type Activity = { id: string; hand: number; text: string; kind: "poker" | "trade" | "system"; at: string };
export type HandResult = { hand: number; winners: number[]; payout: number[]; cashBefore: number; cashAfter: number; pnl: number; description: string };
export type ShowdownOdds = { equities: number[]; method: "exact" | "monte_carlo"; samples: number; standardError: number };
export type SessionView = {
  id: string; version: number; pokerRevision: number; mode: GameMode;
  status: "playing" | "hand_complete" | "complete";
  replayAvailable: boolean; busy: boolean; paused: boolean; hand: number; totalHands: 5; startingBalance: 1000;
  personalitiesEnabled: boolean; ranked: boolean; rankEligible: boolean; notice: string | null;
  street: "preflop" | "flop" | "turn" | "river" | "complete";
  board: string[]; players: PlayerView[]; actor: number | null;
  button: number; pot: number; winners: number[]; winningCards: string[];
  market: MarketView; odds: ShowdownOdds; results: HandResult[]; activity: Activity[];
  pnl: number; tradingOpen: boolean; marketSecondsRemaining: number;
};
export type SessionCommand =
  | { type: "advance"; pokerRevision: number }
  | { type: "next_hand"; pokerRevision: number }
  | { type: "playback"; paused: boolean }
  | { type: "tick" }
  | { type: "order"; pokerRevision: number; outcome: number; side: "buy" | "sell"; quantity: number; limitPrice: number; orderType: "ioc" | "limit" }
  | { type: "cancel"; pokerRevision: number; orderId: string };
export type CommandRequest = SessionCommand & { requestId: string };
export type CompletedGame = {
  id: string; mode: GameMode; ranked: boolean; pnl: number;
  completedAt: string; replayAvailable: boolean;
};
export type GameHistory = { games: CompletedGame[]; nextPage: number | null };
export type ReplayFrame = {
  version: number; at: string; label: string; session: SessionView;
};
export type GameReplay = { id: string; frames: ReplayFrame[] };
export type ApiError = { error: string; code?: string };
