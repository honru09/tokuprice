# tokuprice.com

English tokusatsu collectibles sold-price guide and Japanese market intelligence index.

- Live JPY medians & live USD conversion estimates
- 3-tier condition grading matrix (`New / Sealed`, `Complete in Box`, `Loose / Unboxed`) with parts scrap floor
- Interactive SVG historical trend charts (30D, 90D, 1Y, ALL) and volume velocity sub-histograms
- Price drop waitlist alerts for sub-minute Tokyo flea market snipes (TokuPrice Pro ¥2,980/mo)
- Tokyo Concierge procurement arbitrage bridge (Domestic C2C vs Mandarake vs Western eBay markups)
- Client-side portfolio watchlist tracker (`localStorage`)
- Strict statistical integrity: 100% aggregated secondary market statistics, zero scraped marketplace images or seller descriptions

## Architecture & Data Layer

Driven by a single versioned export file `data/export.json` matching `DATA-SPEC.md`.

- Production export pipeline: Daily at 03:00 JST (18:00 UTC) read-only PostgreSQL aggregation
- Zero invented prices: Empty model array renders honest pipeline compiling state
- Built with Astro 5 static site generation (SSG)
- Deployed to GitHub Pages via GitHub Actions (`.github/workflows/deploy.yml`)

## Develop

```bash
npm install
npm run build         # Builds production static site
npm run test:stress   # Builds with QA break-ui stress fixtures
npm run dev           # Local dev server
```

See `../BUILD.md` for full design-qa verdicts and `../export/EXPORT-SPEC.md` for the production SQL extraction specification.
