import {createCloudHandler} from './cloud-handler.js';
Deno.serve(createCloudHandler({env:(name:string)=>Deno.env.get(name)}));
