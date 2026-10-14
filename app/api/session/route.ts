import {api,getSession,identity,readBody,startSession} from "../../../lib/server";
export function GET() {return api(async()=>({session:await getSession(await identity())}));}
export function POST(request:Request) {return api(async()=>startSession(await identity(),await readBody(request)));}
