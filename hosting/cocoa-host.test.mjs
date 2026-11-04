import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('Cocoa private host authenticates before accessing any tenant node',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'cocoa-host-test-'));
  const secret='test-only-secret'.repeat(3);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cocoa-host.mjs',import.meta.url))],{env:{PATH:process.env.PATH,COCOA_RDK_HOST_SECRET:secret,COCOA_NODE_MASTER_KEY:'12'.repeat(32),COCOA_PUBLIC_API_URL:'https://subzero.example.test',RDK_CENTRAL_URL:'https://central.example.test',COCOA_NODE_DATA_DIR:dir,COCOA_RDK_HOST_PORT:'0',RDK_HOST_SHARED:'false'},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',d=>log+=d);
  try {
    const port=await new Promise((resolve,reject)=> {
      const timeout=setTimeout(()=>reject(new Error('Host startup timed out: '+log)),10000);
      child.stdout.once('data',line=> {clearTimeout(timeout);try {resolve(JSON.parse(line.toString()).port);}catch(e){reject(e);}});
      child.once('exit',code=> {clearTimeout(timeout);reject(new Error('Host exited '+code+': '+log));});
    });
    const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/health')).status,401);
    assert.equal((await fetch(base+'/ensure',{method:'POST',headers:{Authorization:'Bearer wrong'},body:JSON.stringify({scope:'tenant:1',email:'a@example.test'})})).status,401);
    const headers={Authorization:`Bearer ${secret}`,'Content-Type':'application/json'};
    assert.deepEqual(await (await fetch(base+'/health',{headers})).json(),{ok:true,nodes:0,capacity:16,shared:false,queued:0});
    assert.equal((await fetch(base+'/ensure',{method:'POST',headers,body:JSON.stringify({scope:'../../other',email:'a@example.test'})})).status,503);
    assert.equal((await fetch(base+'/sync',{method:'POST',headers,body:JSON.stringify({scope:'tenant:1',apiUrl:'https://attacker.example',projectId:1,token:'stolen'})})).status,503);
    assert.equal((await (await fetch(base+'/health',{headers})).json()).nodes,0);
    assert.equal((await fetch(base+'/arbitrary-command',{method:'POST',headers,body:'{}'})).status,404);
    assert(!log.includes(secret));
  } finally { child.kill('SIGTERM');if(child.exitCode===null && child.signalCode===null) await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true}); }
});

async function start(env){
  const dir=await mkdtemp(join(tmpdir(),'cocoa-host-shared-'));
  const secret='test-only-secret'.repeat(3);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cocoa-host.mjs',import.meta.url))],{env:{PATH:process.env.PATH,COCOA_RDK_HOST_SECRET:secret,COCOA_NODE_MASTER_KEY:'12'.repeat(32),COCOA_PUBLIC_API_URL:'https://subzero.example.test',RDK_CENTRAL_URL:'https://central.example.test',COCOA_NODE_DATA_DIR:dir,COCOA_RDK_HOST_PORT:'0',...env},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',d=>log+=d);
  const port=await new Promise((resolve,reject)=> {
    const timeout=setTimeout(()=>reject(new Error('Host startup timed out: '+log)),10000);
    child.stdout.once('data',line=> {clearTimeout(timeout);try {resolve(JSON.parse(line.toString()).port);}catch(e){reject(e);}});
    child.once('exit',code=> {clearTimeout(timeout);reject(new Error('Host exited '+code+': '+log));});
  });
  const stop=async()=> {child.kill('SIGTERM');if(child.exitCode===null && child.signalCode===null) await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});};
  return {base:`http://127.0.0.1:${port}`,headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},stop,log:()=>log};
}

test('Shared host serves every project from one node, one operation at a time',async()=> {
  const h=await start({RDK_HOST_NODE_EMAIL:'ops@example.test',COCOA_NODE_SCRIPT:fileURLToPath(new URL('./fake-node.fixture.mjs',import.meta.url))});
  try {
    const post=(path,body)=>fetch(h.base+path,{method:'POST',headers:h.headers,body:JSON.stringify(body)});
    const a=await (await post('/ensure',{scope:'subzero:workspace:1:project:1',email:'owner@customer-a.test'})).json();
    const b=await (await post('/ensure',{scope:'subzero:workspace:2:project:7',email:'owner@customer-b.test'})).json();
    assert.equal(a.nodeId,'node-shared');
    assert.deepEqual(b,a,'every scope gets the same node');
    assert.equal(a.shared,true);
    assert.equal(a.email,'ops@example.test','the shared node registers as the operator, never a customer');
    const health=await (await fetch(h.base+'/health',{headers:h.headers})).json();
    assert.deepEqual([health.nodes,health.capacity,health.shared],[1,1,true]);
    // Three projects publishing at once: queued, not refused, never concurrent on the node.
    const token='sz_agent_'+'a'.repeat(64);
    const results=await Promise.all([1,2,3].map(projectId=>post('/sync',{scope:`subzero:workspace:1:project:${projectId}`,apiUrl:'https://subzero.example.test',token,projectId})));
    assert.deepEqual(results.map(r=>r.status),[200,200,200]);
    const bodies=await Promise.all(results.map(r=>r.json()));
    assert.deepEqual(bodies.map(r=>r.projectId).sort(),[1,2,3]);
    assert(bodies.every(r=>r.maxActive===1),'the node never ran two operations at once');
    assert.equal((await post('/sync',{scope:'subzero:workspace:1:project:1',apiUrl:'https://attacker.example',token,projectId:1})).status,503);
  } finally { await h.stop(); }
});

test('Shared host refuses to start without its own node email',async()=> {
  await assert.rejects(start({}),/RDK_HOST_NODE_EMAIL/);
});

