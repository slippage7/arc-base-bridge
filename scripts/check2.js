import puppeteer from 'puppeteer';
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  await page.goto('http://localhost:5173');
  await page.click('#connect-btn');
  await new Promise((r) => setTimeout(r, 1000)); // wait a second (page.waitForTimeout was removed in Puppeteer 22)
  await browser.close();
})();
