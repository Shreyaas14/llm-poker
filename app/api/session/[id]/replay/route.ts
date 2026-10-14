import { api, getReplay, identity } from "../../../../../lib/server";

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => getReplay(await identity(), (await context.params).id));
}
