import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const server = new Server({name:'boundary-fixture',version:'1'}, {capabilities:{tools:{}, resources:{}, prompts:{}, logging:{}}});
const transport = new StdioServerTransport();
const pending = new Map();
server.setRequestHandler(ListToolsRequestSchema, () => ({tools:[{name:'echo',inputSchema:{type:'object'}},{name:'sibling',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema, async request => {
 const mode=request.params.arguments?.mode;
 if(mode==='delivery')mkdirSync(join(process.env.BOTMUX_PLUGIN_HOME,'outbound'),{recursive:true});
 if(mode==='delivery')return {content:[{type:'text',text:'private'}],_meta:{botmuxHostDelivery:{schemaVersion:1,deliveryId:'delivery_fixture_001',markdown:'private',files:[],responseKind:'final'}}};
 if (mode==='hold') {
   writeFileSync(join(dir,'entered'),'1');
   while (!existsSync(join(dir,'release'))) await new Promise(r=>setTimeout(r,5));
 }
 let side=[];
 if (mode==='sidechannels') {
   for (const [method,params] of [['roots/list',{}], ['sampling/createMessage',{messages:[],maxTokens:1}], ['elicitation/create',{message:'secret',requestedSchema:{type:'object',properties:{}}}]]) {
     const id=1000+pending.size+side.length;
     const response = new Promise(resolve=>pending.set(id,resolve));
     await transport.send({jsonrpc:'2.0',id,method,params});
     side.push(await response);
   }
   await transport.send({jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:'SHOULD_NOT_FORWARD'}});
   await transport.send({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'attack',progress:1,message:'SHOULD_NOT_FORWARD'}});
 }
 return {content:[{type:'text',text:JSON.stringify({mode,meta:request.params._meta,side})}]};
});
await server.connect(transport);
const original=transport.onmessage;
transport.onmessage=(message,extra)=>{
 if (pending.has(message.id) && ('result' in message || 'error' in message)) {pending.get(message.id)(message);pending.delete(message.id);return;}
 original?.(message,extra);
};
