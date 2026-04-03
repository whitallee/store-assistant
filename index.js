const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const express = require('express');

puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(RecaptchaPlugin({
  provider: {
    id: '2captcha',
    token: process.env.CAPTCHA_TOKEN,
  },
}));

const app = express();
const PORT = 3000;

const LAUNCH_OPTS = {
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

app.get('/', (req, res) => {
  res.send('Hello World! Server is running.');
});

// Product Location Lookup
// Query params:
//   location    - street address from Apple Shortcuts GPS (e.g. "13729 Research Blvd, Austin, TX 78750")
//   productName - product to search for (e.g. "whole milk")
//
// Flow:
//   1. Opens heb.com and sets the store by typing the GPS address into the store picker.
//      HEB shows nearby stores on the map and we click "Select Store" on the first (nearest) result.
//      Since the customer is physically inside a store, the GPS address resolves to that store.
//   2. Navigates directly to the search results URL for productName.
app.get('/api/v1/product-location-lookup', async (req, res) => {
  const log = (...parts) => console.log('[product-location-lookup]', ...parts);

  const { location, productName } = req.query;

  if (!location || !productName) {
    return res.status(400).json({ error: 'Missing required query params: location, productName' });
  }

  log('1) request', { location, productName });

  const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
  log('2) browser launched');

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://www.heb.com', { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: '/tmp/heb-homepage.png' });
    log('3) homepage loaded — url: %s | screenshot: /tmp/heb-homepage.png', page.url());
    // Wait for the React app to fully render the header
    try {
      await page.waitForSelector('[data-testid="header_change_store"]', { timeout: 3000 });
    } catch (TimeoutError) {
      log('3b) header_change_store not found, probably captcha');
      throw TimeoutError;
    }

    // Step 1: Open the store picker
    await page.click('[data-testid="header_change_store"]');
    log('4) store picker opened');

    // Step 2: Type the address — this triggers autocomplete suggestions
    await page.waitForSelector('#address-input', { timeout: 12000 });
    await page.type('#address-input', location, { delay: 40 });
    log('5) address typed');
    await page.keyboard.press('Enter');
    log('6) submitted via Enter');

    await page.waitForSelector('[data-qe-id="selectStoreButton"]', { timeout: 20000 });
    // TODO: This could cause a bug, because if the button is "selectedStoreButton"
    // instead, then it will be skipped and automatically changed to the next one.
    // If this is the case, for 1 store based on the server's location, then 1 store should be skipped always.


    // Click the first "Select Store"
    const allSelectStoreBtns = await page.$$('[data-qe-id="selectStoreButton"]');
    await allSelectStoreBtns[0].click();
    log('7) clicked "Select Store"');

    // Step 5: Wait for the modal to close
    await page.waitForFunction(
      () => document.querySelector('#address-input') === null || document.querySelector('#address-input')?.offsetParent === null,
      { timeout: 10000 }
    );
    log('8) store picker modal closed');

    const selectedStore = await page.evaluate(() =>
      document.querySelector('[data-testid="header_change_store"]')?.textContent?.trim() ?? null
    );
    log('9) selected store:', selectedStore);

    // Step 6: Navigate directly to the search results URL
    const searchUrl = `https://www.heb.com/search?q=${encodeURIComponent(productName)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    log('10) search results page:', page.url());

    await page.screenshot({ path: '/tmp/heb-search-results.png' });
    log('10b) search results page screenshot — url: %s | screenshot: /tmp/heb-search-results.png', page.url());

    // Step 6: Parse the first product result for aisle location and stock status
    const products = await page.evaluate(() => {
      const results = [];

      // Each product card on the search results page
      const cards = document.querySelectorAll('[class*="ProductCard"], [class*="ProductTile"], [class*="product-card"]');

      cards.forEach((card, i) => {
        if (i >= 5) return; // top 5 results

        const name = card.querySelector('[class*="ProductName"], [class*="productName"], h3, h2')?.textContent?.trim();
        const price = card.querySelector('[class*="Price"], [class*="price"]')?.textContent?.trim();

        // Aisle location — same component used across the whole site
        const location = card.querySelector('[class*="ProductLocation"], [class*="storeMapText"], [class*="storeMap"]')?.textContent?.trim();

        // Out of stock — look for disabled add-to-cart or explicit OOS text
        const addToCartBtn = card.querySelector('button');
        const isOutOfStock = !!(
          card.querySelector('[class*="OutOfStock"], [class*="outOfStock"], [class*="out-of-stock"]') ||
          addToCartBtn?.disabled ||
          addToCartBtn?.textContent?.toLowerCase().includes('out of stock') ||
          addToCartBtn?.textContent?.toLowerCase().includes('unavailable')
        );

        if (name) results.push({ name, price, location: location ?? null, inStock: !isOutOfStock });
      });

      return results;
    });

    log('11) parsed product cards:', products.length);

    // Step 7: Click the ProductLocation span on the first result to open the store map drawer
    let storeMapSvg = null;
    try {
      const locationBtn = await page.$('[class*="ProductLocation"]');
      if (locationBtn) {
        await locationBtn.click();
        await page.waitForSelector('[data-testid="store-map"]', { timeout: 8000 });
        storeMapSvg = await page.evaluate(() =>
          document.querySelector('[data-testid="store-map"]')?.outerHTML ?? null
        );
        log('11) store map SVG:', storeMapSvg ? `${storeMapSvg.length} chars` : 'none');
      } else {
        log('11) no ProductLocation control; skipping map');
      }
    } catch (mapErr) {
      log('11) store map failed:', mapErr.message);
    }

    const topResult = products[0] ?? null;
    log('12) responding', { selectedStore, topResultName: topResult?.name ?? null });
    res.json({
      success: true,
      selectedStore,
      query: productName,
      topResult,
      allResults: products,
      storeMapSvg,
    });
  } catch (err) {
    console.error('[product-location-lookup] error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
    log('browser closed');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
