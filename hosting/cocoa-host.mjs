import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const secret = process.env.COCOA_RDK_HOST_SECRET ?? '';
const master = process.env.COCOA_NODE_MASTER_KEY ?? '';
if (secret.length < 32 || !/^[a-f0-9]{64}$/i.test(master)) throw new Error('Configure a host secret and 32-byte node master key');
const central = process.env.RDK_CENTRAL_URL ?? 'https://rdk.retrodeck.ai';
const subzero = process.env.COCOA_PUBLIC_API_URL;
if (!subzero?.startsWith('https://') || !central.startsWith('https://')) throw new Error('Configure HTTPS SubZero and Central URLs');
const root = resolve(process.env.COCOA_NODE_DATA_DIR ?? '/var/lib/cocoa');
const maxNodes = Number(process.env.COCOA_MAX_NODES ?? 16);
if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1000) throw new Error('Invalid node capacity');
const nodes = new Map();
function authorize(header) {
  const value = typeof header === 'string' ? header : '';
  const expected = `Bearer ${secret}`;
  return Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value),Buffer.from(expected));
}
async function operation(action, body) {
  if (typeof body.scope !== 'string' || !/^[a-zA-Z0-9:_-]{1,240}$/.test(body.scope)) throw new Error('invalid scope');
  const scope = createHash('sha256').update(body.scope).digest('hex');
  let entry = nodes.get(scope);
  if (!entry) {
    if (action !== 'ensure' || typeof body.email !== 'string' || !body.email.includes('@') || body.email.length > 254) throw new Error('ensure the node first');
    if (nodes.size >= maxNodes) throw new Error('node capacity reached');
    // Reserve capacity before asynchronous filesystem work to prevent duplicate starts.
    entry = { child:null, pending:new Map(), active:Date.now(), starting:true };
    nodes.set(scope,entry);
    try {
      const dir = join(root,scope);
      await mkdir(dir,{recursive:true,mode:0o700});
      entry.child = fork(fileURLToPath(new URL('./cocoa-node.mjs',import.meta.url)),[],{
        env:{ PATH:process.env.PATH,NODE_ENV:'production',RDK_HOME:dir,RDK_MODELS_DIR:join(root,'models'),RDK_CONFIG_ENCRYPTION_KEY:createHmac('sha256',Buffer.from(master,'hex')).update(scope).digest('hex'),RDK_CENTRAL_URL:central,COCOA_NODE_SCOPE:scope },
        stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=256'],
      });
      entry.child.on('message',message=> {
        const pending=entry.pending.get(message.id); if(!pending) return;
        entry.pending.delete(message.id); clearTimeout(pending.timer);
        if(message.error) pending.reject(new Error('node operation failed')); else pending.resolve(message.result);
      });
      entry.child.on('exit',()=> {
        if(nodes.get(scope)===entry) nodes.delete(scope);
        for(const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('node stopped')); }
      });
      entry.child.on('error',()=>entry.child.kill());
      entry.starting=false;
    } catch(e) { nodes.delete(scope); throw e; }
  }
  if(entry.starting || entry.pending.size) throw new Error('node busy');
  if(action==='sync' && (body.apiUrl!==subzero || !/^sz_agent_[a-f0-9]{64}$/.test(body.token??'') || !Number.isSafeInteger(body.projectId) || body.projectId<1)) throw new Error('invalid publisher');
  entry.active=Date.now();
  return new Promise((resolve,reject)=> {
    const id=randomUUID();
    const timer=setTimeout(()=> { entry.pending.delete(id); entry.child.kill(); reject(new Error('node timeout')); },85000);
    entry.pending.set(id,{resolve,reject,timer});
    entry.child.send({id,action,body});
  });
}
const server=createServer(async(req,res)=> {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Cache-Control','no-store');
  if(!authorize(req.headers.authorization)) { res.writeHead(401); res.end('{"error":"Unauthorized"}'); return; }
  if(req.method==='GET' && req.url==='/health') {res.end(JSON.stringify({ok:true,nodes:nodes.size,capacity:maxNodes}));return;}
  const action=req.url==='/ensure'?'ensure':req.url==='/sync'?'sync':null;
  if(req.method!=='POST' || !action) {res.writeHead(404);res.end('{}');return;}
  try {
    let raw=''; for await(const chunk of req) {raw+=chunk; if(Buffer.byteLength(raw)>16000) throw new Error('body too large');}
    const result=await operation(action,JSON.parse(raw));res.end(JSON.stringify(result));
  } catch {res.writeHead(503);res.end('{"error":"Private storage unavailable; check host capacity and configuration"}');}
});
server.requestTimeout=100000;
server.headersTimeout=10000;
server.listen(Number(process.env.COCOA_RDK_HOST_PORT??4250),process.env.COCOA_RDK_HOST_BIND??'127.0.0.1',()=>{console.log(JSON.stringify({event:'listening',port:server.address().port}));});
const sweep=setInterval(()=> {for(const entry of nodes.values()) if(!entry.starting && !entry.pending.size && entry.active<Date.now()-10*60000) entry.child.kill();},60000);
sweep.unref();
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=> {for(const entry of nodes.values())entry.child?.kill();server.close(()=>process.exit(0));});
