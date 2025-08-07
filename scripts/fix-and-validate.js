#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');

const baseURL = 'https://genaiglobal.org';
const port = 3000;
const threshold = 0.1; // percent
const viewport = { width: 1920, height: 1080 };


const reportDir = path.join(process.cwd(), 'reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

function execPromise(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

async function discoverFiles(root) {
  const files = { html: [], css: [], js: [] };
  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (full.endsWith('.html')) files.html.push(full);
      else if (full.endsWith('.css')) files.css.push(full);
      else if (full.endsWith('.js')) files.js.push(full);
    }
  }
  walk(root);
  return files;
}

async function fixHtml(file) {
  const content = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(content);

  // Remove invalid Tailwind placeholders like '...'
  $('[class]').each((_, el) => {
    const cls = $(el).attr('class');
    if (cls.includes('...')) {
      $(el).attr('class', cls.replace(/\.+/g, ' ').trim());
    }
  });

  // Ensure includes for head-section and top-panel
  const headInclude = fs.existsSync('head-section.html') ? fs.readFileSync('head-section.html', 'utf8') : '';
  const topInclude = fs.existsSync('top-panel.html') ? fs.readFileSync('top-panel.html', 'utf8') : '';
  if (headInclude && !$('head').html().includes(headInclude.trim())) {
    $('head').prepend(headInclude);
  }
  if (topInclude && !$('body').html().includes(topInclude.trim())) {
    $('body').prepend(topInclude);
  }

  // Sync basic text content with live site using ids
  try {
    const rel = path.relative(process.cwd(), file);
    const liveRes = await fetch(`${baseURL}/${rel}`);
    const liveHtml = await liveRes.text();
    const $live = cheerio.load(liveHtml);
    $('[id]').each((_, el) => {
      const id = $(el).attr('id');
      const liveEl = $live(`#${id}`);
      if (liveEl.length) $(el).text(liveEl.text());
    });
  } catch (e) {
    // ignore network errors
  }

  fs.writeFileSync(file, $.html());
}

async function fixPhase(files) {
  for (const file of files.html) await fixHtml(file);
}

async function runHtmlValidator(files, results) {
  for (const file of files.html) {
    const { stdout, stderr } = await execPromise(`npx html-validator --quiet --file="${file}"`, { env: process.env });
    if (stderr) results.html.push({ file, stderr });
  }
}

async function runStylelint(files, results) {

  if (stderr) results.js.push({ stderr });
}

async function startServer() {
  const server = exec(`npx http-server -p ${port}`, { cwd: process.cwd() });
  await new Promise(r => setTimeout(r, 2000));
  return server;
}

async function runPa11y(pages, results) {
  for (const page of pages) {
    const { stderr } = await execPromise(`npx pa11y http://localhost:${port}/${page}`);
    if (stderr) results.accessibility.push({ page, stderr });
  }
}

async function runAxe(pages, results) {

  for (const page of pages) {
    try {
      const pageObj = await browser.newPage();
      await pageObj.setViewport(viewport);
      await pageObj.goto(`http://localhost:${port}/${page}`, { waitUntil: 'networkidle2' });
      const { violations } = await require('axe-puppeteer').AxePuppeteer(pageObj).analyze();
      if (violations.length) results.accessibility.push({ page, stderr: JSON.stringify(violations) });
    } catch (e) {
      results.accessibility.push({ page, stderr: e.message });
    }
  }
  await browser.close();
}

async function runBrokenLinks(results) {
  const { stderr } = await execPromise(`npx blc http://localhost:${port} -ro`);
  if (stderr) results.links.push({ stderr });
}

async function runCspell(results) {

  if (stderr) results.spell.push({ stderr });
}

async function runDomDiff(pages, results) {

  for (const page of pages) {
    try {
      const p1 = await browser.newPage();
      await p1.setViewport(viewport);
      await p1.goto(`http://localhost:${port}/${page}`, { waitUntil: 'networkidle2' });
      const localHtml = await p1.$eval('#content', el => el.innerHTML).catch(() => '');
      await p1.goto(`${baseURL}/${page}`, { waitUntil: 'networkidle2' });
      const liveHtml = await p1.$eval('#content', el => el.innerHTML).catch(() => '');
      if (localHtml !== liveHtml) results.dom.push({ page, diff: true });
      await p1.close();
    } catch (e) {
      results.dom.push({ page, diff: true, error: e.message });
    }
  }
  await browser.close();
}

async function runVisualDiff(pages, results) {

  for (const page of pages) {
    const pLocal = await browser.newPage();
    await pLocal.setViewport(viewport);
    await pLocal.goto(`http://localhost:${port}/${page}`, { waitUntil: 'networkidle2' });
    const localBuffer = await pLocal.screenshot({ fullPage: true });
    await pLocal.goto(`${baseURL}/${page}`, { waitUntil: 'networkidle2' });
    const liveBuffer = await pLocal.screenshot({ fullPage: true });
    const img1 = PNG.sync.read(localBuffer);
    const img2 = PNG.sync.read(liveBuffer);
    const { width, height } = img1;
    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height);
    const pct = (diffPixels / (width * height)) * 100;
    if (pct > threshold) results.visual.push({ page, pct });
    fs.writeFileSync(path.join(reportDir, `${page.replace(/\//g,'_')}-diff.png`), PNG.sync.write(diff));
    await pLocal.close();
  }
  await browser.close();
}

async function runLighthouse(pages, results) {
  for (const page of pages) {
    const { stderr } = await execPromise(`npx lighthouse http://localhost:${port}/${page} --quiet --chrome-flags="--headless" --output json --output-path=${path.join(reportDir, `lighthouse-${page.replace(/\//g,'_')}.json`)}`);
    if (stderr) results.lighthouse.push({ page, stderr });
  }
}

async function validationPhase(files, pages) {
  const results = { html: [], css: [], js: [], accessibility: [], links: [], spell: [], dom: [], visual: [], lighthouse: [] };
  await runHtmlValidator(files, results);
  await runStylelint(files, results);
  await runEslint(files, results);
  const server = await startServer();
  await runPa11y(pages, results);
  await runAxe(pages, results);
  await runBrokenLinks(results);
  await runCspell(results);
  await runDomDiff(pages, results);
  await runVisualDiff(pages, results);
  await runLighthouse(pages, results);
  server.kill();
  return results;
}

function summarize(res) {
  const failures = Object.values(res).reduce((a, arr) => a + arr.length, 0);
  return failures;
}

(async () => {
  const files = await discoverFiles(process.cwd());
  const pages = files.html.map(f => path.relative(process.cwd(), f));
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await fixPhase(files);
    const results = await validationPhase(files, pages);
    fs.writeFileSync(path.join(reportDir, 'validation-report.json'), JSON.stringify(results, null, 2));
    const failures = summarize(results);
    if (failures === 0) {
      console.log('🎉 ALL FILES FIXED & VALIDATED — READY TO MERGE!');
      process.exit(0);
    }
    console.log(`Attempt ${attempt} completed with ${failures} issues.`);
  }
  console.log('Validation failed after maximum attempts.');
  process.exit(1);
})();

