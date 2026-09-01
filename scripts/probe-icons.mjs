import puppeteer from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1706, height: 960 });
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'domcontentloaded' });
await sleep(3000);
const title = await page.title();
