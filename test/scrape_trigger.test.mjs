/* The button that starts the scraper. What matters here is what must never
   happen: the GitHub token reaching the browser or a response body, a GET
   starting a run, a second click starting a second run inside the cooldown,
   or a caller's text reaching the workflow unchecked.

   Run: node test/scrape_trigger.test.mjs */

const store=new Map();
globalThis.caches={default:{
  async match(u){const e=store.get(u);return e?new Response(e.body,{status:200,headers:e.headers}):undefined;},
  async put(u,r){store.set(u,{body:await r.text(),headers:Object.fromEntries(r.headers)});}}};
let calls=[];
globalThis.fetch=async(u,init)=>{calls.push({url:String(u),init});
  return new Response(null,{status:204});};
const worker=(await import('../src/worker.js')).default;
let pass=0,fail=0;
const check=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?'  -> '+JSON.stringify(x):'')));};
const post=(env,body)=>worker.fetch(new Request('https://x.test/api/scrape',{method:'POST',
  body:JSON.stringify(body||{}),headers:{'Content-Type':'application/json'}}),env,{waitUntil:()=>{}});
const get=(env)=>worker.fetch(new Request('https://x.test/api/scrape'),env,{waitUntil:()=>{}});
const ASSETS={fetch:async()=>new Response('a')};

console.log('\n== without a token it does nothing, and says so ==');
{
  store.clear();calls=[];
  const env={ASSETS};
  const r=await post(env); const b=await r.json();
  check('refuses with 503',r.status===503,r.status);
  check('reports itself unconfigured',b.configured===false,b);
  check('and never called GitHub',calls.length===0,calls.length);
  const s=await (await get(env)).json();
  check('status says the button should be disabled',s.configured===false,s);
}

console.log('\n== with a token, POST dispatches the workflow ==');
{
  store.clear();calls=[];
  const env={ASSETS,SCRAPE_TOKEN:'secret-value',SCRAPE_REPO:'o/r',SCRAPE_REF:'main'};
  const r=await post(env); const b=await r.json();
  check('accepted',r.status===202&&b.ok===true,[r.status,b]);
  check('hit the workflow dispatch endpoint',
    /repos\/o\/r\/actions\/workflows\/scrape-outages\.yml\/dispatches$/.test(calls[0].url),calls[0].url);
  check('with the branch it was told',JSON.parse(calls[0].init.body).ref==='main',calls[0].init.body);
  check('the token is sent as a bearer header',
    calls[0].init.headers.Authorization==='Bearer secret-value',Object.keys(calls[0].init.headers));
  check('and the token never appears in the response',
    !JSON.stringify(b).includes('secret-value'),b);
}

console.log('\n== a GET never starts anything ==');
{
  store.clear();calls=[];
  const env={ASSETS,SCRAPE_TOKEN:'t'};
  await get(env);
  check('no dispatch from a GET',calls.length===0,calls.length);
}

console.log('\n== the cooldown holds ==');
{
  store.clear();calls=[];
  const env={ASSETS,SCRAPE_TOKEN:'t'};
  await post(env);
  const second=await post(env); const b=await second.json();
  check('a second run is refused',second.status===429,second.status);
  check('only one dispatch went out',calls.length===1,calls.length);
  check('and it says how long to wait',b.cooldownSeconds>0,b);
  const s=await (await get(env)).json();
  check('the status reports the cooldown too',s.cooldownSeconds>0,s);
}

console.log('\n== only known states reach the workflow ==');
{
  store.clear();calls=[];
  const env={ASSETS,SCRAPE_TOKEN:'t'};
  await post(env,{only:'nsw, vic, ../../etc, DROP TABLE'});
  const sent=JSON.parse(calls[0].init.body);
  check('unknown values are dropped',sent.inputs.only==='nsw,vic',sent.inputs);
}

console.log('\n== GitHub refusing is reported, not swallowed ==');
{
  store.clear();calls=[];
  globalThis.fetch=async()=>new Response('Not Found',{status:404});
  const env={ASSETS,SCRAPE_TOKEN:'t'};
  const b=await (await post(env)).json();
  check('the failure surfaces',b.ok===false&&/HTTP 404/.test(b.error),b.error);
  check('with the likely cause named',/token|workflow/i.test(b.error),b.error);
}

console.log('\n----------------------------------------');
console.log('passed: '+pass+'   failed: '+fail);
process.exit(fail?1:0);
