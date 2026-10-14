import {api,executeCommand,identity,readBody} from "../../../../../lib/server";
export function POST(request:Request,context:{params:Promise<{id:string}>}) {return api(async()=>executeCommand(await identity(),(await context.params).id,await readBody(request)));}
