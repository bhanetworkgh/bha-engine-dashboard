import { chromium } from 'playwright';
const OUT = process.argv[2];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs=[], acts=[];
p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
p.on('console',m=>{ if(m.type()==='error')errs.push(m.text()); if(m.text().startsWith('[action]'))acts.push(m.text()); });
await p.goto('http://localhost:5173/'); await p.waitForTimeout(400);
await p.screenshot({path:`${OUT}/00-login.png`});
await p.fill('#password','x'); await p.click('button[type=submit]'); await p.waitForTimeout(600);
const nav=['Overview','Ask Bays','North Star','Research Twin','vFarm','Engine health','Open loops','Codex entries','Build patterns','Commercial','Builders'];
let i=1;
for(const n of nav){
  await p.click(`nav a:has-text("${n}")`); await p.waitForTimeout(420);
  await p.screenshot({path:`${OUT}/${String(i).padStart(2,'0')}-${n.replace(/ /g,'-')}.png`});
  const t=(await p.textContent('main'))||'';
  console.log(`${n.padEnd(15)} chars=${String(t.length).padStart(5)} rows=${await p.locator('tbody tr').count()}`);
  i++;
}
for (const [page,tabs] of [['North Star',['Records','Runs','Gaps','Summary']],['Research Twin',['Records','Runs','Gaps','Summary']],['vFarm',['Lifecycle','Readiness','Live']],['Open loops',['Review queue','Reconciliation','Loops']]]) {
  await p.click(`nav a:has-text("${page}")`); await p.waitForTimeout(320);
  for(const t of tabs){ await p.click(`button:has-text("${t}")`); await p.waitForTimeout(240);
    await p.screenshot({path:`${OUT}/tab-${page.replace(/ /g,'-')}-${t.replace(/ /g,'-')}.png`}); }
}
await p.click('nav a:has-text("Engine health")'); await p.waitForTimeout(350);
await p.click('tbody tr'); await p.waitForTimeout(250);
await p.screenshot({path:`${OUT}/exp-incident.png`});
await p.click('nav a:has-text("Open loops")'); await p.waitForTimeout(380);
const row=p.locator('tbody tr').first(); await row.hover(); await p.waitForTimeout(120);
await row.locator('button',{hasText:'close'}).first().click(); await p.waitForTimeout(150);
await p.click('nav a:has-text("Builders")'); await p.waitForTimeout(320);
await p.click('a:has-text("Jegan")'); await p.waitForTimeout(420);
await p.screenshot({path:`${OUT}/builder-jegan.png`});
await p.selectOption('select','CLIENT_CORE'); await p.waitForTimeout(350);
await p.click('nav a:has-text("vFarm")'); await p.waitForTimeout(420);
await p.screenshot({path:`${OUT}/lane-vfarm.png`});
await p.click('nav a:has-text("Overview")'); await p.waitForTimeout(420);
await p.screenshot({path:`${OUT}/lane-overview.png`});
console.log('actions:', acts.join(' | ')||'NONE');
console.log('errors:', errs.length?errs.join('\n'):'none');
await b.close();
