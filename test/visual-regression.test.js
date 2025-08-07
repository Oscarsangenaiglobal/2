const httpServer = require('http-server');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch').default;
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const baseURL = 'https://genaiglobal.org';
const pages = [
  'index.html',
  'about-us.html',
  'community.html',
  'events.html',
  'resources.html',
  'get-involved.html',
  'spotlight.html',
  'log-in.html'
];
const threshold = 0.1; // percent difference allowed

async function main() {
  const port = 3000;
  const server = httpServer.createServer({ root: process.cwd() });
  await new Promise(resolve => server.listen(port, resolve));

  const browser = await puppeteer.launch({
    ignoreHTTPSErrors: true,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    defaultViewport: { width: 1920, height: 1080 }
  });

  const results = [];

  try {
    for (const pagePath of pages) {
      const page = await browser.newPage();

      const localURL = `http://localhost:${port}/${pagePath}`;
      const liveURL = `${baseURL}/${pagePath}`;

      await page.goto(localURL, { waitUntil: 'networkidle0' });
      const localShot = await page.screenshot({ fullPage: true });

      await page.goto(liveURL, { waitUntil: 'networkidle0' });
      const liveShot = await page.screenshot({ fullPage: true });

      await page.close();

      const localPNG = PNG.sync.read(localShot);
      const livePNG = PNG.sync.read(liveShot);

      const width = Math.max(localPNG.width, livePNG.width);
      const height = Math.max(localPNG.height, livePNG.height);
      const localPadded = new PNG({ width, height });
      const livePadded = new PNG({ width, height });
      PNG.bitblt(localPNG, localPadded, 0, 0, localPNG.width, localPNG.height, 0, 0);
      PNG.bitblt(livePNG, livePadded, 0, 0, livePNG.width, livePNG.height, 0, 0);

      const diffPNG = new PNG({ width, height });
      const diffPixels = pixelmatch(
        localPadded.data,
        livePadded.data,
        diffPNG.data,
        width,
        height,
        { threshold: 0.1 }
      );

      const totalPixels = width * height;
      const diffPercent = (diffPixels / totalPixels) * 100;
      const passed = diffPercent <= threshold;

      results.push({
        page: pagePath,
        diffPixels,
        diffPercentage: diffPercent,
        passed
      });

      if (passed) {
        console.log(`✔ ${pagePath} (${diffPercent.toFixed(2)}% diff)`);
      } else {
        console.log(`✖ ${pagePath} (${diffPercent.toFixed(2)}% diff > ${threshold}%)`);
      }
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    const reportDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(reportDir, 'visual-diffs.json'),
      JSON.stringify(results, null, 2)
    );

    const allPassed = results.every(r => r.passed);
    if (!allPassed && process.exitCode === 0) {
      process.exitCode = 1;
    }
  }
}

main();
