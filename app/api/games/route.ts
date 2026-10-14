import { api, completedGames, identity } from "../../../lib/server";
import { z } from "zod";

export function GET(request: Request) {
  return api(async () => {
    const page = z.coerce.number().int().min(0).max(10000).parse(new URL(request.url).searchParams.get("page") ?? 0);
    return completedGames(await identity(), page);
  });
}
