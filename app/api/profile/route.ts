import {api,identity,readBody,saveProfile} from "../../../lib/server";
export function POST(request:Request) {return api(async()=>saveProfile(await identity(),await readBody(request)));}
