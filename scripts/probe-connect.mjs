import puppeteer from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:5273/';

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1706, height: 960 });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('deprecated')) console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));

const nodes = await page.$$('.react-flow__node');
let pcBox = null, swBox = null;
for (const n of nodes) {
  const t = await n.evaluate((el) => el.textContent || '');
  const b = await n.boundingBox();
  if (t.includes('PC-0')) pcBox = b;
  if (t.includes('Switch-0')) swBox = b;
}

// 悬停 PC-0 使蓝点可见
await page.mouse.move(pcBox.x + pcBox.width / 2, pcBox.y + pcBox.height / 2);
await new Promise((r) => setTimeout(r, 500));

// 找 PC-0 的 right 蓝点（可见）
const dot = await page.evaluateHandle(() => {
  const node = [...document.querySelectorAll('.react-flow__node')].find((n) => (n.textContent || '').includes('PC-0'));
  return [...node.querySelectorAll('.react-flow__handle')].find((h) => h.className.includes('handle-right') && getComputedStyle(h).opacity !== '0');
});
const db = await dot.asElement().boundingBox();
if (!db) { console.log('NO VISIBLE DOT'); process.exit(1); }
console.log('DOT:', JSON.stringify({ x: Math.round(db.x), y: Math.round(db.y), w: Math.round(db.width) }));

const edgesBefore = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);

// 按住蓝点拖到 Switch-0 中心
await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 200));
const mid = await page.evaluate(() => ({
  conn: document.querySelectorAll('.react-flow__connection').length,
  evts: (window.__ev || []).length,
}));
await page.mouse.move(swBox.x + swBox.width / 2, swBox.y + swBox.height / 2, { steps: 14 });
await new Promise((r) => setTimeout(r, 250));
await page.mouse.up();
await new Promise((r) => setTimeout(r, 600));

const edgesAfter = await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length);
console.log('MID:', JSON.stringify(mid));
console.log('RESULT:', JSON.stringify({ edgesBefore, edgesAfter, connected: edgesAfter === edgesBefore + 1 }));
await browser.close();
