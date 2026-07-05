// Drive the VISIBLE Chrome (agent-chrome profile, CDP :11001) through the
// join → open-detail flow and sample the header, verifying the seed fix on
// the freshly deployed web build.
import puppeteer from 'puppeteer';
const TOKEN = process.env.TOKEN;
const JOIN = `https://mac13.cicy-ai.com?flag=addTeam&token=${TOKEN}`;
const OUT = process.env.OUT || '.';

const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:11001', defaultViewport: null });
// don't b.pages() — attaching to every tab of this live profile hangs; open
// our own fresh tab and leave the user's tabs alone.
const p = await b.newPage();
console.log('[0] new tab');
await p.goto('https://telegram-bot.cicy-ai.com', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 1500));
console.log('[1] url:', p.url());

if (p.url().includes('/scan')) {
  const inp = await p.$('input, textarea');
  await inp.click();
  await p.keyboard.type(JOIN, { delay: 2 });
  await new Promise(r => setTimeout(r, 400));
  const addBtn = await p.evaluate(() => {
    const cands = [...document.querySelectorAll('div, button')]
      .filter(e => /^(add|加入|join)$/i.test((e.textContent || '').trim()))
      .map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, area: r.width*r.height }; })
      .filter(c => c.area > 0).sort((a,b) => a.area - b.area);
    return cands[0] || null;
  });
  await p.mouse.click(addBtn.x, addBtn.y);
  await new Promise(r => setTimeout(r, 3000));
}
console.log('[2] url:', p.url());

// install a recorder BEFORE tapping, then tap the w-10036 row
await p.evaluate(() => {
  window.__rec = [];
  const t0 = performance.now();
  const iv = setInterval(() => {
    window.__rec.push([Math.round(performance.now() - t0),
      document.body.innerText.split('\n').slice(0, 5).join('|').slice(0, 100)]);
  }, 60);
  setTimeout(() => clearInterval(iv), 4000);
});
const row = await p.evaluate(() => {
  const els = [...document.querySelectorAll('div')]
    .filter(d => (d.textContent || '').includes('w-10036') && (d.textContent || '').length < 60)
    .map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, area: r.width*r.height }; })
    .filter(c => c.area > 0).sort((a,b) => a.area - b.area);
  return els[0] || null;
});
console.log('[3] row:', JSON.stringify(row));
await p.mouse.click(row.x, row.y);
await new Promise(r => setTimeout(r, 4200));
const rec = await p.evaluate(() => window.__rec || []);
for (const [t, s] of rec) if (t < 2600) console.log(String(t).padStart(5), s);
await p.screenshot({ path: `${OUT}/live-detail.png` });
b.disconnect();
