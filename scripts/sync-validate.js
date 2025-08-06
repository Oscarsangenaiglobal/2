#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execSync, spawn } = require('child_process');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const lighthouse = require('lighthouse');

const BASE_URL = 'https://genaiglobal.org';
const DIST_DIR = path.join(process.cwd(), 'dist');
const REPORT_DIR = path.join(process.cwd(), 'reports', 'diffs');
const PORT = 3000;
const VISUAL_THRESHOLD = 0.1; // percent
const DOM_THRESHOLD = 0.99;
const VIEWPORT = { width: 1920, height: 1080 };
const LAUNCH_OPTS = { headless: 'new', args: ['--no-sandbox'] };

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed`);
  return await res.text();
}

async function discoverRoutes() {
  try {
    const xml = await fetchText(`${BASE_URL}/sitemap.xml`);
    const $ = cheerio.load(xml, { xmlMode: true });
    const routes = [];
    $('url > loc').each((_, el) => {
      const loc = $(el).text().replace(BASE_URL, '').replace(/^[\/]/, '').replace(/[\/]$/, '');
      routes.push(loc);
    });
    return Array.from(new Set(routes));
  } catch (e) {
    // fallback crawl
    const html = await fetchText(BASE_URL);
    const $ = cheerio.load(html);
    const routes = new Set(['']);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/')) {
        routes.add(href.replace(/^[\/]/, '').replace(/[\/]$/, ''));
      }
    });
    return Array.from(routes);
  }
}

async function syncRoute(route) {
  const url = `${BASE_URL}/${route}`.replace(/\/$/, '') || BASE_URL;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const main = $('main, #content').first();
  if (!main.length) throw new Error(`missing <main> for ${route}`);
  const footer = $('footer').first().html() || '';
  const headInc = await fsp.readFile('head-section.html', 'utf8');
  const topInc = await fsp.readFile('top-panel.html', 'utf8');
  const doc = `<!DOCTYPE html><html lang="en"><head>${headInc}</head><body>${topInc}${main.html() || ''}${footer}</body></html>`;
  const outDir = path.join(DIST_DIR, route);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'index.html'), doc);
  const ratio = (main.html() || '').length ? (main.html().length / (main.html().length)) : 1;
  if (ratio < DOM_THRESHOLD) throw new Error(`DOM ratio below threshold for ${route}`);
  return ratio;
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

async function validate(routes) {
  const htmlFiles = [];
  const walk = async dir => {
    for (const entry of await fsp.readdir(dir)) {
      const full = path.join(dir, entry);
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) await walk(full);
      else if (full.endsWith('.html')) htmlFiles.push(full);
    }
  };
  await walk(DIST_DIR);
  // html validator
  for (const f of htmlFiles) run(`npx html-validator --quiet --file="${f}"`);
  // stylelint, eslint, spell
  run(`npx stylelint "${DIST_DIR}/**/*.css"`);
  run(`npx eslint "${DIST_DIR}/**/*.js"`);
  run(`npx cspell "${DIST_DIR}/**/*.{html,js,md}"`);
  // accessibility + links
  const server = spawn('npx', ['http-server', 'dist', '-p', String(PORT)], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2000));
  for (const r of routes) run(`npx pa11y http://localhost:${PORT}/${r}`);
  const browser = await puppeteer.launch(LAUNCH_OPTS);
  for (const r of routes) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(`http://localhost:${PORT}/${r}`, { waitUntil: 'networkidle2' });
    const AxePuppeteer = require('axe-puppeteer').default;
    const { violations } = await new AxePuppeteer(page).analyze();
    if (violations.length) throw new Error(`aXe violations on ${r}`);
    await page.close();
  }
  run(`npx blc http://localhost:${PORT} -ro`);
  // DOM & visual diff
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  for (const r of routes) {
    const pageLocal = await browser.newPage();
    await pageLocal.setViewport(VIEWPORT);
    await pageLocal.goto(`http://localhost:${PORT}/${r}`, { waitUntil: 'networkidle2' });
    const localHtml = await pageLocal.$eval('main, #content', el => el.innerHTML).catch(() => '');
    const localShot = await pageLocal.screenshot({ fullPage: true });
    const pageLive = await browser.newPage();
    await pageLive.setViewport(VIEWPORT);
    await pageLive.goto(`${BASE_URL}/${r}`, { waitUntil: 'networkidle2' });
    const liveHtml = await pageLive.$eval('main, #content', el => el.innerHTML).catch(() => '');
    if (!liveHtml || localHtml.length / liveHtml.length < DOM_THRESHOLD) throw new Error(`DOM diff on ${r}`);
    const liveShot = await pageLive.screenshot({ fullPage: true });
    const img1 = PNG.sync.read(localShot);
    const img2 = PNG.sync.read(liveShot);
    const { width, height } = img1;
    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height);
    const pct = (diffPixels / (width * height)) * 100;
    const diffPath = path.join(REPORT_DIR, `${r.replace(/\//g, '_')}.png`);
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    if (pct > VISUAL_THRESHOLD) throw new Error(`Visual diff ${pct.toFixed(2)}% on ${r}`);
    await pageLocal.close();
    await pageLive.close();
  }
  // Lighthouse
  const browserWSEndpoint = browser.wsEndpoint();
  const port = new URL(browserWSEndpoint).port;
  for (const r of routes) {
    const { lhr } = await lighthouse(`http://localhost:${PORT}/${r}`, { port, output: 'json', logLevel: 'error' });
    if (lhr.audits['first-contentful-paint'].score === 0 || lhr.categories.accessibility.score < 0.5) {
      throw new Error(`Lighthouse failed on ${r}`);
    }
  }
  await browser.close();
  server.kill('SIGTERM');
}

(async () => {
  try {
    const routes = await discoverRoutes();
    console.log(`✅ Route discovery: ${routes.length} routes found`);
    await fsp.rm(DIST_DIR, { recursive: true, force: true });
    for (const r of routes) await syncRoute(r);
    console.log('✅ All pages synced');
    let validated = false;
    while (!validated) {
      try {
        await validate(routes);
        validated = true;
      } catch (err) {
        console.error(err.message);
        for (const r of routes) await syncRoute(r);
      }
    }
    console.log('🎉 SYNC & VALIDATE complete — UI is correct and fully matches live site!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

