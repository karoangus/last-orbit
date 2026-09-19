const {test, expect} = require('@playwright/test');

async function boot(page, manual = true) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if(msg.type() === 'warning' && msg.text().includes('event error')) errors.push(msg.text()); });
  if(manual) await page.addInitScript(() => { window.requestAnimationFrame = () => 1; });
  await page.goto('/?debug');
  await page.evaluate(() => {
    window.__lo.settings.muted = true;
    window.__loSeed = 2026;
  });
  return errors;
}
async function run(page) {
  await page.evaluate(() => {
    const g = window.__lo;
    g.startGame();
    for(let i=0; i<181; i++) g.step(1/60);
    g.state.nextEvent = 1e6;
  });
}

test('launch, countdown 3 → 2 → 1, both route lengths', async ({page}) => {
  const errors = await boot(page);
  await page.click('[data-mode="classic"]');
  await page.click('#startBtn');
  const result = await page.evaluate(() => {
    const g = __lo, labels=[];
    g.step(1/60); labels.push(document.querySelector('#toast').textContent);
    for(let i=0;i<60;i++)g.step(1/60);
    labels.push(document.querySelector('#toast').textContent);
    for(let i=0;i<60;i++)g.step(1/60);
    labels.push(document.querySelector('#toast').textContent);
    for(let i=0;i<60;i++)g.step(1/60);
    return {labels, phase:g.state.phase, total:g.state.total};
  });
  expect(result).toEqual({labels:['۳','۲','۱'],phase:'run',total:9000});
  await page.evaluate(() => { __lo.settings.mode = 'quick'; __lo.resetGame(); });
  expect(await page.evaluate(() => __lo.state.total)).toBe(3000);
  expect(errors).toEqual([]);
});

test('real-time flight pauses on blur and resumes without background catch-up', async ({page}) => {
  await boot(page, false);
  await page.click('#startBtn');
  await expect.poll(() => page.evaluate(() => __lo.state.phase)).toBe('run');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#pauseOverlay')).toBeVisible();
  const before = await page.evaluate(() => ({time:__lo.state.time, o2:__lo.state.oxygen}));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => ({time:__lo.state.time, o2:__lo.state.oxygen}))).toEqual(before);
  await page.click('#resumeBtn');
  await expect.poll(() => page.evaluate(() => __lo.state.time)).toBeGreaterThan(before.time);
  expect(await page.evaluate(() => __lo.state.time)).toBeLessThan(before.time + .5);
});

test('pause freezes countdown, crew, resources and rejects actions', async ({page}) => {
  await boot(page); await run(page);
  const result = await page.evaluate(() => {
    const g=__lo, inc=g.openIncident('engHeat',{sev:1}), o=g.optList(inc)[0];
    g.startOption(inc,o);
    g.pauseGame();
    const snapshot=()=>JSON.stringify({time:g.state.time,oxygen:g.state.oxygen, energy:g.state.energy, crew:g.npcsRef().map(n=>[n.pos,n.fat,n.task?.t])});
    const before=snapshot();
    for(let i=0;i<120;i++)g.step(1/60);
    g.thrust();g.startOption(inc,o);g.restCrew(g.npcsRef()[3]);
    return {before, after:snapshot(), phase:g.state.phase, held:g.state.holding};
  });
  expect(result.before).toBe(result.after); expect(result.phase).toBe('paused'); expect(result.held).toBe(false);
});

test('cooldown cannot be bypassed and engine guard prevents overheating', async ({page}) => {
  await boot(page);await run(page);
  const result = await page.evaluate(() => {
    const g=__lo;
    g.thrust();g.thrust();g.thrust();
    const count=g.state.thrusts;
    g.state.cooldown=0;g.state.temperature=76;g.thrust();
    const guarded=g.state.thrusts;
    g.settings.guard=false;g.thrust();
    return {count,guarded,manual:g.state.thrusts};
  });
  expect(result).toEqual({count:1,guarded:1,manual:2});
});

test('incident locks release and interrupted tasks never leave ghost assignments', async ({page}) => {
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo, fight=g.openIncident('crewFight',{sev:1});
    const locked=g.npcsRef().filter(n=>n.locked);
    const owned=locked.every(n=>n.lockBy===fight.uid);
    g.closeIncident(fight,'solve');
    const freed=locked.every(n=>g.crewFree(n));
    const inc=g.openIncident('engHeat',{sev:1});g.startOption(inc,g.optList(inc)[0]);
    const lead=inc.task.crew[0];g.injure(lead,'test');
    return {owned,freed,assigned:inc.assigned,task:!!inc.task,leadTask:!!lead.task,path:!!lead.path};
  });
  expect(result).toEqual({owned:true,freed:true,assigned:false,task:false,leadTask:false,path:false});
});

test('crew arriving at station keep working; recall clears travel path', async ({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,inc=g.openIncident('engHeat',{sev:1});g.startOption(inc,g.optList(inc)[0]);
    const n=inc.task.crew[0],path=JSON.stringify(n.path);
    g.npcReact('window');const same=JSON.stringify(n.path)===path && n.state==='busy';
    for(let i=0;i<600;i++)g.step(1/60);
    const started=inc.task?.go && inc.task.t>0;
    g.recallIncident(inc);
    return {same,started,free:g.crewFree(n),path:!!n.path,assigned:inc.assigned};
  });
  expect(result).toEqual({same:true,started:true,free:true,path:false,assigned:false});
});

test('swapping a two-person task preserves team size without charging twice',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,inc=g.openIncident('engHeat',{sev:1});
    const o={...g.optList(inc)[0],need:2,energy:5};g.startOption(inc,o);
    const replacement=g.npcsRef().find(n=>g.crewFree(n)), before=g.state.energy;
    g.swapCrew(inc,replacement);
    return {team:inc.task.crew.length,lead:inc.task.crew[0]===replacement,charged:before-g.state.energy};
  });
  expect(result).toEqual({team:2,lead:true,charged:0});
});

test('resting crew are reserved, and multiple injuries can each receive treatment',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,ns=g.npcsRef();g.restCrew(ns[0]);const resting=!g.crewFree(ns[0]);
    for(let i=0;i<1700;i++)g.step(1/60);
    const rested=g.crewFree(ns[0]);g.injure(ns[0],'test');g.injure(ns[1],'test');
    const first=g.state.incidents.find(i=>i.key==='crewInjury');
    ns[0].injured=false;g.closeIncident(first,'solve');g.directorTick(.01);
    const second=g.state.incidents.find(i=>i.key==='crewInjury');
    return {resting,rested,target:second.m.id};
  });
  expect(result).toEqual({resting:true,rested:true,target:1});
});

test('support checkpoints award once, allow choice, and cannot be farmed by drifting',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,s=g.state;s.distance=s.total*2/3-1;g.missionTick();g.missionTick();
    const first=s.supplyStock;s.distance=s.total;g.missionTick();s.distance=900;g.missionTick();
    const both=s.supplyStock;s.energy=10;s.oxygen=20;g.pauseGame();g.claimSupply('energy');g.claimSupply('oxygen');g.claimSupply('energy');
    return {first,both,energy:s.energy,o2:s.oxygen,stock:s.supplyStock,used:s.supplies};
  });
  expect(result).toEqual({first:1,both:2,energy:40,o2:28,stock:0,used:2});
});

test('retry clears neglect, buffs, alerts, checkpoints and stale mission UI',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo;g.openIncident('crewFight',{sev:1});g.renderIncBar();
    Object.assign(g.state,{neglect:9,rareCount:4,sector:2,supplyStock:2,log:[1],_acd:9});
    g.resetGame();
    return {neglect:g.state.neglect,rare:g.state.rareCount,sector:g.state.sector,stock:g.state.supplyStock,log:g.state.log,acd:g.state._acd,locked:g.npcsRef().some(n=>n.locked),inc:document.querySelector('#incBar').textContent};
  });
  expect(result).toEqual({neglect:0,rare:0,sector:0,stock:0,log:[],acd:0,locked:false,inc:''});
});

test('options unlock at their exact energy cost, not an unrelated threshold',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,inc=g.openIncident('engHeat',{sev:1});const o=g.optList(inc)[0];
    g.state.energy=0;g.renderIncBar();
    const before=document.querySelector('[data-opt="0"]').disabled;
    g.state.energy=o.energy;g.renderIncBar();
    return {before,after:document.querySelector('[data-opt="0"]').disabled};
  });
  expect(result).toEqual({before:true,after:false});
});

test('modifier decay updates continuously and oxygen HUD uses seconds × 60',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo;g.state.buffs.push({k:'regen',v:1,t:10,t0:10});g.computeMods();
    const initial=g.state.mods.regen;for(let i=0;i<300;i++)g.step(1/60);
    const after=g.state.mods.regen;g.state.o2Rate=.1;g.state.mods.o2=0;g.updateHUD();
    return {initial,after,text:document.querySelector('#o2SubVal').textContent};
  });
  expect(result.after).toBeLessThan(result.initial*.6);expect(result.text).toContain('۶');
});

test('records and preferences persist, malformed storage does not break startup',async({page})=>{
  await boot(page);await run(page);
  await page.evaluate(()=>{ __lo.state.distance=0;__lo.step(1/60); });
  await expect(page.locator('#endOverlay')).toBeVisible();
  await expect(page.locator('#scoreReport')).toContainText('رکورد جدید');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('last-orbit-v2-records')));
  expect(saved.quick.score).toBeGreaterThan(2000);
  await page.reload();await expect(page.locator('#bestRecord')).toContainText(saved.quick.score.toLocaleString('fa-IR'));
  await page.evaluate(()=>localStorage.setItem('last-orbit-v2-settings','{broken'));
  await page.reload();await expect(page.locator('#startBtn')).toBeVisible();
});

test('unavailable audio and storage never prevent starting a mission',async({page})=>{
  await page.addInitScript(()=>{
    window.AudioContext=undefined;window.webkitAudioContext=undefined;
    Storage.prototype.setItem=()=>{throw Error('blocked');};Storage.prototype.getItem=()=>{throw Error('blocked');};
  });
  const errors=await boot(page);await run(page);
  expect(await page.evaluate(()=>__lo.state.phase)).toBe('run');expect(errors).toEqual([]);
});

test('all event definitions open, render, escalate, and complete options without runtime errors',async({page})=>{
  test.setTimeout(60000);
  const errors=await boot(page);
  const count=await page.evaluate(()=>{
    const g=__lo;let count=0;
    for(const key of Object.keys(g.EV)){
      g.resetGame();g.state.phase='run';g.state.crew=g.npcsRef().length;
      const inc=g.openIncident(key,{sev:1,reqId:0});
      if(!inc)throw Error('Failed opening '+key);
      g.computeMods();g.renderIncBar();g.renderSysStrip();g.openCrewCard(g.npcsRef()[0]);
      g.incidentsTick(.1);
      for(const o of g.optList(inc)){
        if(!o?.label)throw Error('Invalid option '+key);
      }
      g.escalate(inc);g.renderIncBar();
      if(g.state.incidents.includes(inc)){
        const o=g.optList(inc)[0];if(o)g.finishOption(inc,o,g.npcsRef()[0]);
      }
      count++;
    }
    return count;
  });
  expect(count).toBeGreaterThan(60);expect(errors).toEqual([]);
});

test('long seeded simulations preserve crew ownership and finite bounded resources',async({page})=>{
  test.setTimeout(90000);
  const errors=await boot(page);
  const results=await page.evaluate(()=>{
    const g=__lo,results=[];
    for(const mode of ['quick','classic'])for(const seed of [7,42,2026]){
      window.__loSeed=seed;g.settings.mode=mode;g.resetGame();g.state.phase='run';g.state.auto=true;g.setPolicy('smart');
      for(let i=0;i<60*2400&&g.state.phase==='run';i++){
        g.step(1/60);
        if(i%60===0){
          if(g.state.supplyStock)g.claimSupply(g.state.oxygen<65?'oxygen':'energy');
          for(const key of ['oxygen','energy','temperature'])if(!Number.isFinite(g.state[key])||g.state[key]<0||g.state[key]>100.001)throw Error(key+' out of bounds');
          for(const inc of g.state.incidents){
            if(inc.assigned!==!!inc.task)throw Error('ghost task '+inc.key);
            if(inc.task?.crew.some(n=>n.task!==inc.task))throw Error('crew ownership '+inc.key);
          }
          if(g.state.incidents.length>4||g.state.queue.length>3)throw Error('unbounded director');
        }
      }
      results.push({seed,mode,time:g.state.time,phase:g.state.phase,distance:g.state.distance});
    }
    return results;
  });
  console.log('Seeded journeys',results);
  expect(results.every(r=>r.phase==='end')).toBe(true);expect(errors).toEqual([]);
});

test('mobile and desktop controls fit the viewport and support keyboard focus',async({page})=>{
  await boot(page);await run(page);
  const geometry=await page.evaluate(()=>{
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height};};
    return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,viewport:rect('viewport'),thrust:rect('thrustBtn')};
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  expect(geometry.viewport.height).toBeGreaterThan(140);
  expect(geometry.thrust.bottom).toBeLessThanOrEqual(geometry.height);
  await page.evaluate(()=>__lo.pauseGame());
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(()=>!!document.activeElement.closest('#pauseOverlay'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#pauseOverlay')).toBeHidden();
});

test('installed shell works offline and activation keeps unrelated caches',async({page,context})=>{
  await page.goto('/?debug');
  await page.evaluate(async()=>{ await navigator.serviceWorker.ready;await caches.open('other-app-cache'); });
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);await page.reload();
  await expect(page.locator('#startBtn')).toBeVisible();await page.click('#startBtn');
  expect(await page.evaluate(()=>__lo.state.phase)).toBe('countdown');
  expect(await page.evaluate(()=>caches.has('other-app-cache'))).toBe(true);
});

test('30, 60 and 120 Hz produce the same simulation time and distance', async ({page})=>{
  await boot(page);
  const results=await page.evaluate(()=>{
    const g=__lo, results=[];
    for(const hz of [30,60,120]){
      g.resetGame();g.state.phase='run';g.state.nextEvent=1e6;
      const start=performance.now();
      for(let i=1;i<=hz*10;i++)g.frame(start+i*1000/hz);
      results.push({time:g.state.time,distance:g.state.distance});
    }
    return results;
  });
  for(const r of results){expect(r.time).toBeCloseTo(10,1);expect(r.distance).toBeCloseTo(2990,1);}
});

test('description rendering does not change gameplay RNG or probability estimates',async({page})=>{
  await boot(page);await run(page);
  const result=await page.evaluate(()=>{
    const g=__lo,inc=g.openIncident('navDrift',{sev:1});inc.stage=1;
    const first=g.stageDesc(inc);g.renderIncBar();const second=g.stageDesc(inc);
    const o=g.optList(inc)[0],n=g.npcsRef()[2];o._inc=inc;
    return {first,second,display:g.optChance(o,n),actual:Math.round((1-g.failureChance(o,inc,n))*100)};
  });
  expect(result.first).toBe(result.second);expect(result.display).toBe(result.actual);
});

test('keyboard launch-to-thrust works and paused panel is not frozen invisible',async({page})=>{
  await boot(page);await run(page);
  await page.keyboard.press('Space');
  expect(await page.evaluate(()=>__lo.state.thrusts)).toBe(1);
  await page.keyboard.press('KeyP');
  await expect(page.locator('#pauseOverlay .panel')).toHaveCSS('opacity','1');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>__lo.state.phase)).toBe('run');
});

test('small portrait/landscape layouts fit with support package unlocked',async({page})=>{
  await boot(page);await run(page);
  for(const size of [{width:360,height:640},{width:844,height:390}]){
    await page.setViewportSize(size);
    await page.evaluate(()=>{__lo.state.distance=1000;__lo.missionTick();__lo.frame(performance.now()+100);});
    const r=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,bottom:document.querySelector('#thrustBtn').getBoundingClientRect().bottom}));
    expect(r.scroll).toBeLessThanOrEqual(r.width);expect(r.bottom).toBeLessThanOrEqual(r.height);
    await expect(page.locator('#supplyBtn')).toBeVisible();
  }
});

test('every option in every event stage can finish safely',async({page})=>{
  test.setTimeout(90000);
  const errors=await boot(page);
  const count=await page.evaluate(()=>{
    const g=__lo;let count=0;
    for(const [key,def] of Object.entries(g.EV)){
      const stages=def.stages || [{opts:def.opts}];
      for(let stage=0;stage<stages.length;stage++)for(let idx=0;idx<(stages[stage].opts?.length || 0);idx++){
        g.resetGame();g.state.phase='run';const inc=g.openIncident(key,{sev:2,reqId:0});inc.stage=stage;
        const o=g.optList(inc)[idx];o._inc=inc;
        g.finishOption(inc,o,g.npcsRef()[0]);g.computeMods();g.renderIncBar();g.step(1/60);
        if(!Number.isFinite(g.state.oxygen)||!Number.isFinite(g.state.energy))throw Error(key+' invalid option '+idx);
        count++;
      }
    }
    return count;
  });
  expect(count).toBeGreaterThan(200);expect(errors).toEqual([]);
});
