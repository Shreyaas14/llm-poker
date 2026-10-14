import {api,bootstrap,identity} from "../../../lib/server";
export function GET() {return api(async()=>bootstrap(await identity()));}
