import {api,endSession,getSession,identity,readBody} from "../../../../lib/server";
export function GET(_request:Request,context:{params:Promise<{id:string}>}) {return api(async()=>getSession(await identity(),(await context.params).id));}
export function DELETE(request:Request,context:{params:Promise<{id:string}>}) {return api(async()=>{await readBody(request);return endSession(await identity(),(await context.params).id);});}
