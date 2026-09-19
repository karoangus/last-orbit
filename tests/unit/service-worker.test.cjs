const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const scope = 'https://example.test/last-orbit/';

function worker(fetchImpl = async () => new Response('network')) {
  const stores = new Map(), listeners = {}, timers = new Set();
  const caches = {
    async open(key) {
      if(!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key);
      return {
        async addAll(paths) { paths.forEach(p => store.set(new URL(p,scope).href, new Response('cached shell'))); },
        async put(url,response) { store.set(String(url),response.clone()); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
    async match(url) {
      for(const store of stores.values()) if(store.has(String(url))) return store.get(String(url)).clone();
    }
  };
  const self = {
    registration:{scope},location:{origin:'https://example.test'},
    addEventListener:(name,callback)=>{ listeners[name]=callback; },
    skipWaiting:async()=>{},clients:{claim:async()=>{}}
  };
  vm.runInNewContext(fs.readFileSync('sw.js','utf8'), {
    self,caches,URL,Response,AbortController,Set,Promise,
    fetch:(...args)=>fetchImpl(...args),
    setTimeout:callback=>{timers.add(callback);return callback;},clearTimeout:id=>timers.delete(id)
  });
  return {
    stores,timers,caches,
    async install() { let p;listeners.install({waitUntil:x=>{p=x;}});await p; },
    async activate() { let p;listeners.activate({waitUntil:x=>{p=x;}});await p; },
    async request(path,method='GET') {
      let result;const background=[];
      listeners.fetch({request:{url:new URL(path,scope).href,method},respondWith:p=>{result=p;},waitUntil:p=>background.push(p)});
      const response=await result;await Promise.all(background);return response;
    },
    network:fn=>{fetchImpl=fn;}
  };
}

test('activation deletes only this game’s stale caches, not another app/scope',async()=>{
  const w=worker();
  for(const name of ['other-app','last-orbit:https://example.test/another/:1','last-orbit:'+scope+':1','last-orbit-v4'])await w.caches.open(name);
  await w.install();await w.activate();
  assert.deepEqual(await w.caches.keys(),['other-app','last-orbit:https://example.test/another/:1','last-orbit:'+scope+':2.0.0']);
});
test('fresh navigation refreshes the canonical shell; query URLs work offline',async()=>{
  const w=worker();await w.install();
  assert.equal(await (await w.request('./?debug')).text(),'network');
  w.network(async()=>{throw Error('offline');});
  assert.equal(await (await w.request('./?another-query')).text(),'network');assert.equal(w.timers.size,0);
});
test('HTTP errors fall back to shell instead of replacing it',async()=>{
  const w=worker(async()=>new Response('server error',{status:503}));await w.install();
  assert.equal(await (await w.request('./')).text(),'cached shell');assert.equal(w.timers.size,0);
});
test('offline without cache returns an explicit response, not undefined',async()=>{
  const w=worker(async()=>{throw Error('offline');});
  assert.equal((await w.request('./')).status,503);assert.equal(w.timers.size,0);
});
test('static stale-while-revalidate waits for and stores the background response',async()=>{
  const w=worker();await w.install();
  const url=new URL('./manifest.webmanifest',scope).href;
  assert.equal(await (await w.request('./manifest.webmanifest')).text(),'cached shell');
  assert.equal(await (await w.caches.match(url)).text(),'network');
});
test('unknown assets, other origins and writes are not intercepted',async()=>{
  const w=worker();await w.install();
  for(const path of ['not-a-game-asset.json','https://other.test/'])assert.equal(await w.request(path),undefined);
  assert.equal(await w.request('./','POST'),undefined);
});
