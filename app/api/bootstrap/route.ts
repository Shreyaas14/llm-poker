import {api,bootstrap,identity} from "../../../lib/server";
export function GET(request: Request) {return api(async()=>bootstrap(await identity(), new URL(request.url).searchParams.get("includeSession") === "1"));}
