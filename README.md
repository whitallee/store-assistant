# Store Assistant

A Node.js API that looks up product locations on HEB.com using a GPS address (from Apple Shortcuts) to automatically select the nearest store, then returns matching products and their in-store aisle location.

Designed to be triggered via Siri/Apple Shortcuts while on the floor.

> **Planned:** Absorb the [seafood-sku-lookup](https://github.com/whitallee/seafood-sku-lookup) project into this one.

---

## How It Works

1. Apple Shortcuts sends the device's GPS address and a product name to the API
2. The server opens HEB.com via headless Chromium and sets the store using the GPS address — since you're physically inside a store, it resolves to that location
3. Navigates to search results for the product and parses the top matches, including name, price, stock status, and aisle location

CAPTCHAs are handled automatically via 2captcha.

---

## API

```
GET /api/v1/product-location-lookup?location=<address>&productName=<product>
```

| Param | Description |
|---|---|
| `location` | Street address from GPS (e.g. `13729 Research Blvd, Austin, TX 78750`) |
| `productName` | Product to search for (e.g. `whole milk`) |

**Response:**
```json
{
  "success": true,
  "selectedStore": "HEB #123",
  "query": "whole milk",
  "topResult": {
    "name": "H-E-B Whole Milk",
    "price": "$3.49",
    "location": "Dairy, Aisle 4",
    "inStock": true
  },
  "allResults": [...],
  "storeMapSvg": "..."
}
```

---

## Running Locally

```bash
cp .env.example .env
# add your CAPTCHA_TOKEN to .env

npm install
node index.js
# → http://localhost:3000
```

Requires Chromium installed at `/usr/bin/chromium`.

---

## Environment Variables

```env
CAPTCHA_TOKEN=   # 2captcha API key
```
