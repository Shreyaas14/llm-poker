declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    AI_GATEWAY_API_KEY?: string;
    LIVE_MODELS_READY?: string;
    POKER_MODEL_GPT?: string;
    POKER_MODEL_CLAUDE?: string;
    POKER_MODEL_GEMINI?: string;
    POKER_MODEL_GROK?: string;
  }
}
