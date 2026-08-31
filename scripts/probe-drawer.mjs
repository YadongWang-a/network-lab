import puppeteer from 'puppeteer-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1706, height: 960 });
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodes = await page.$$('.react-flow__node');
let pc = null;
for (const n of nodes) { const t = await n.evaluate((el) => el.textContent || ''); if (t.includes('PC-0')) { pc = n; break; } }
const pcb = await pc.boundingBox();
const cx = pcb.x + pcb.width / 2, cy = pcb.y + pcb.height / 2;

// 1) 真实点击终端按钮 → 终端开、抽屉不开
await page.mouse.move(cx, cy);
await sleep(500);
const termBtn = await pc.$('button');
const tb = await termBtn.boundingBox();
await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await sleep(600);
const step1 = await page.evaluate(() => ({
  termOpen: (document.body.textContent || '').includes('终端 · PC-0'),
  drawerClosed: !document.querySelector('.ant-drawer-open'),
}));

// 2) 关终端 → 真实点击设备本体 → 抽屉开 → 真实改 IP → 真实点保存 → 名牌更新
await page.evaluate(() => { const c = [...document.querySelectorAll('.ant-card')].find((c) => (c.textContent || '').includes('终端 · PC-0')); if (c) { const a = [...c.querySelectorAll('a')].find((a) => a.textContent === '关闭' || a.textContent === 'Close'); if (a) a.click(); } });
await sleep(600);
await page.mouse.click(cx, cy);
await sleep(700);
const drawerWasOpen = await page.evaluate(() => Boolean(document.querySelector('.ant-drawer-open')));
await page.evaluate(() => { const el = [...document.querySelectorAll('.ant-drawer-open input')].find((i) => i.value === '192.168.1.10'); if (el) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, '192.168.1.99'); el.dispatchEvent(new Event('input', { bubbles: true })); } });
const saveBtn = await page.$('.ant-drawer-open form button[type=submit]');
const sb = saveBtn ? await saveBtn.boundingBox() : null;
if (sb) await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
await sleep(800);
const step2 = await page.evaluate(() => ({
  drawerClosedAfterSave: !document.querySelector('.ant-drawer-open'),
  plateUpdated: (document.body.textContent || '').includes('192.168.1.99'),
}));

console.log('RESULT:', JSON.stringify({ step1, step2 }, null, 2));
await browser.close();
