import puppeteer from 'puppeteer-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1706, height: 960 });
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A) 渲染检查
const render = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.react-flow__node').length,
  edges: document.querySelectorAll('.react-flow__edge').length,
  title: (document.body.textContent || '').includes('PackeTTrino 网络模拟器'),
}));

// B) 拖拽连线：悬停 PC-0 → 右侧蓝点 → 拖到 Switch-0
const nodes = await page.$$('.react-flow__node');
let pcBox = null, swBox = null;
for (const n of nodes) { const t = await n.evaluate((el) => el.textContent || ''); const b = await n.boundingBox(); if (t.includes('PC-0')) pcBox = b; if (t.includes('Switch-0')) swBox = b; }
await page.mouse.move(pcBox.x + pcBox.width / 2, pcBox.y + pcBox.height / 2);
await sleep(400);
const dots = await page.evaluate(() => [...document.querySelectorAll('.react-flow__handle')].filter((h) => h.closest('.react-flow__node')?.textContent.includes('PC-0') && getComputedStyle(h).opacity !== '0').length);
const dot = await page.evaluateHandle(() => [...document.querySelectorAll('.react-flow__handle')].find((h) => h.closest('.react-flow__node')?.textContent.includes('PC-0') && h.className.includes('handle-right') && getComputedStyle(h).opacity !== '0'));
const db = await dot.asElement().boundingBox();
const edgesBefore = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);
await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
await page.mouse.down();
await page.mouse.move(swBox.x + swBox.width / 2, swBox.y + swBox.height / 2, { steps: 10 });
await page.mouse.up();
await sleep(400);
const edgesAfterDrag = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);

// C) 演示命令：PC-0 ping Switch-0 → 报文动画 + 轨迹同步
await page.evaluate(() => { const b = [...document.querySelectorAll('button,img')].find((x) => (x.getAttribute && x.getAttribute('alt')) === 'cmd'); if (b) b.click(); });
await sleep(500);
async function pickInCmd(i, text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const card = await page.evaluateHandle(() => [...document.querySelectorAll('.ant-card')].find((c) => (c.textContent || '').includes('演示命令')));
    const cardEl = card.asElement();
    if (!cardEl) { await sleep(300); continue; }
    const sel = (await cardEl.$$('.ant-select'))[i];
    if (!sel) { await sleep(300); continue; }
    const b = await sel.boundingBox();
    if (!b) { await sleep(300); continue; }
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(400);
    const opt = await page.evaluateHandle((t) => [...document.querySelectorAll('.ant-select-item-option')].find((o) => o.textContent.includes(t) && !o.closest('.ant-select-dropdown').classList.contains('ant-select-dropdown-hidden')), text);
    const oe = opt.asElement();
    if (!oe) { await sleep(300); continue; }
    const ob = await oe.boundingBox();
    if (!ob) { await sleep(300); continue; }
    await page.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2);
    await sleep(300);
    return true;
  }
  return false;
}
const p1 = await pickInCmd(0, 'PC-0');
const p2 = await pickInCmd(2, 'Switch-0');
const tracesBefore = await page.evaluate(() => document.querySelectorAll('.ant-list-item').length);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('执行')); if (b) b.click(); });
await sleep(700);
const dotsDuring = await page.evaluate(() => document.querySelectorAll('.viz-dot').length);
await sleep(5000);
const fin = await page.evaluate(() => ({
  tracesAfter: document.querySelectorAll('.ant-list-item').length,
  dotsLeft: document.querySelectorAll('.viz-dot').length,
  edgesFinal: document.querySelectorAll('.react-flow__edge').length,
}));
console.log(JSON.stringify({
  render, dotsVisible: dots, edgesBefore, edgesAfterDrag, dragConnected: edgesAfterDrag === edgesBefore + 1,
  cmdPicks: { p1, p2 }, tracesBefore, dotsDuring, ...fin, tracesAdded: fin.tracesAfter - tracesBefore,
}, null, 2));
await browser.close();
