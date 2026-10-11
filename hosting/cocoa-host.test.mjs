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
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cocoa-host.mjs',import.meta.url))],{env:{PATH:process.env.PATH,COCOA_RDK_HOST_SECRET:secret,COCOA_NODE_MASTER_KEY:'12'.repeat(32),COCOA_PUBLIC_API_URL:'https://subzero.example.test',RDK_CENTRAL_URL:'https://central.example.test',COCOA_NODE_DATA_DIR:dir,COCOA_RDK_HOST_PORT:'0'},stdio:['ignore','pipe','pipe']});
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
    assert.deepEqual(await (await fetch(base+'/health',{headers})).json(),{ok:true,nodes:0,capacity:16});
    assert.equal((await fetch(base+'/ensure',{method:'POST',headers,body:JSON.stringify({scope:'../../other',email:'a@example.test'})})).status,503);
    assert.equal((await fetch(base+'/sync',{method:'POST',headers,body:JSON.stringify({scope:'tenant:1',apiUrl:'https://attacker.example',projectId:1,token:'stolen'})})).status,503);
    assert.equal((await (await fetch(base+'/health',{headers})).json()).nodes,0);
    assert.equal((await fetch(base+'/arbitrary-command',{method:'POST',headers,body:'{}'})).status,404);
    assert(!log.includes(secret));
  } finally { child.kill('SIGTERM');if(child.exitCode===null && child.signalCode===null) await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true}); }
});
