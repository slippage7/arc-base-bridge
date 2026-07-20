import puppeteer from 'puppeteer';
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('dialog', async dialog => {
    console.log('DIALOG OPENED:', dialog.message());
    await dialog.accept();
  });

  await page.goto('http://localhost:5173');
  console.log("Navigated to localhost:5173");
  
  const btnText = await page.$eval('#connect-btn', el => el.textContent);
  console.log("Connect button text:", btnText);
  
  await page.click('#connect-btn');
  console.log("Clicked connect button. Waiting 1 second...");
  
  await new Promise(r => setTimeout(r, 1000));
  
  const afterBtnText = await page.$eval('#connect-btn', el => el.textContent);
  console.log("Button text after click:", afterBtnText);
  
  await browser.close();
})();
