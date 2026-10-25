# tokuprice.com — Production Data Export Specification

**Site:** `tokuprice.com`  
**Vertical:** Japanese Tokusatsu Sold-Price Index  
**Target Output:** `site/data/export.json`  
**Status:** Ready for Wiring by Main Agent on Production Machine  
**Database Source:** PostgreSQL replica (`saas-repo/packages/db/prisma/schema.prisma`)  
**Cadence:** Daily at 03:00 JST (18:00 UTC)  

---

## 1. Overview & Data Flow

```
[PostgreSQL Database Replica (Read-Only)]
                   │
                   ▼ (Cron: 03:00 JST / 18:00 UTC)
       [export-tokuprice.ts / .py]
                   │
                   ▼ (Validates Schema & Computes Percentiles)
          [data/export.json]
                   │
                   ▼ (Git Commit / Push to honru09/tokuprice)
         [GitHub Actions Workflow]
                   │
                   ▼ (Astro 5 SSG Build)
      [https://tokuprice.com Deployment]
```

All data queries operate strictly on a **read-only database connection**. Zero writes or mutations are made to production tables during this job.

---

## 2. Source Tables in `schema.prisma`

The queries query three existing Prisma models:
1. **`Product` (`products`)**: Canonical catalog definition.
   - Columns: `id`, `canonical_key`, `canonical_name`, `normalized_name`, `title_zh`, `product_line`, `model_number`, `release_year`, `franchise_id`, `series_id`.
   - Relations: `franchise` (`franchises`), `series` (`series`).
2. **`Item` (`"Item"`)**: Ingested marketplace listings.
   - Columns: `id`, `product_id`, `status` (`'sold'`), `conditionGrade` (`'new_sealed'`, `'like_new'`, `'used'`, `'stained_or_damaged'`, `'junk'`), `priceCurrent`, `priceTotalEst`, `detectedAt`, `needsReview` (`false`).
3. **`ExchangeRate` (`exchange_rates`)**: Daily currency rates (`baseCurrency = 'USD'`, `targetCurrency = 'JPY'`).

---

## 3. Exact Read-Only SQL Queries

### Query 1: Active Canonical Models Catalog
Pulls all products assigned to Kamen Rider and Ultraman with verified listings:

```sql
SELECT 
    p.id AS product_id,
    p.canonical_key AS slug,
    p.canonical_name AS canonical_name_en,
    COALESCE(p.title_zh, p.canonical_name) AS canonical_name_ja,
    p.normalized_name AS romaji,
    p.release_year,
    f.key AS franchise_key,
    f.name_en AS franchise_name_en,
    s.key AS series_key,
    s.name_en AS series_name_en,
    COALESCE(p.product_line, 'dx_belt') AS toy_type,
    'Bandai' AS manufacturer
FROM products p
JOIN franchises f ON p.franchise_id = f.id
LEFT JOIN series s ON p.series_id = s.id
WHERE f.key IN ('kamen_rider', 'ultraman')
ORDER BY p.release_year DESC, p.canonical_name ASC;
```

---

### Query 2: Rolling 30-Day and 90-Day Medians & Quantiles (Overall)
Calculates overall sold transaction statistics excluding unreviewed / outlier records:

```sql
WITH sold_items AS (
    SELECT 
        i.product_id,
        i."priceTotalEst" AS price,
        i."detectedAt" AS sold_at
    FROM "Item" i
    WHERE i.status = 'sold'
      AND i."needsReview" = false
      AND i.product_id IS NOT NULL
      AND i."detectedAt" >= NOW() - INTERVAL '90 days'
),
stats_30d AS (
    SELECT 
        product_id,
        COUNT(*) AS sold_volume_30d,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_30d,
        PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY price) AS p10_30d,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY price) AS p90_30d,
        AVG(price) AS avg_price_30d
    FROM sold_items
    WHERE sold_at >= NOW() - INTERVAL '30 days'
    GROUP BY product_id
),
stats_prior_30d AS (
    SELECT 
        product_id,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_prior_30d
    FROM sold_items
    WHERE sold_at >= NOW() - INTERVAL '60 days'
      AND sold_at < NOW() - INTERVAL '30 days'
    GROUP BY product_id
),
stats_90d AS (
    SELECT 
        product_id,
        COUNT(*) AS sold_volume_90d,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_90d
    FROM sold_items
    GROUP BY product_id
)
SELECT 
    p.id AS product_id,
    COALESCE(s30.median_30d, s90.median_90d, 0)::INT AS median_price_jpy,
    COALESCE(s30.p10_30d, 0)::INT AS price_min_jpy,
    COALESCE(s30.p90_30d, 0)::INT AS price_max_jpy,
    COALESCE(s30.sold_volume_30d, 0)::INT AS sold_volume_30d,
    COALESCE(s90.sold_volume_90d, 0)::INT AS sold_volume_90d,
    CASE 
        WHEN sp.median_prior_30d IS NOT NULL AND sp.median_prior_30d > 0 THEN 
            ROUND(((s30.median_30d - sp.median_prior_30d)::NUMERIC / sp.median_prior_30d::NUMERIC) * 100, 1)
        ELSE 0.0 
    END AS price_trend_pct_30d
FROM products p
LEFT JOIN stats_30d s30 ON p.id = s30.product_id
LEFT JOIN stats_prior_30d sp ON p.id = sp.product_id
LEFT JOIN stats_90d s90 ON p.id = s90.product_id
WHERE s90.sold_volume_90d > 0;
```

---

### Query 3: Condition Grade Segmentation (Sealed / CIB / Loose / Junk)
Groups sold transactions by condition grade for each product:

```sql
SELECT 
    i.product_id,
    i."conditionGrade"::TEXT AS condition_grade,
    COUNT(*)::INT AS sold_count_30d,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i."priceTotalEst"))::INT AS median_price_jpy,
    ROUND(PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY i."priceTotalEst"))::INT AS price_min_jpy,
    ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY i."priceTotalEst"))::INT AS price_max_jpy
FROM "Item" i
WHERE i.status = 'sold'
  AND i."needsReview" = false
  AND i.product_id IS NOT NULL
  AND i."detectedAt" >= NOW() - INTERVAL '30 days'
  AND i."conditionGrade" IN ('new_sealed', 'like_new', 'used', 'stained_or_damaged', 'junk')
GROUP BY i.product_id, i."conditionGrade";
```

Condition mapping:
- `'new_sealed'` → `new_sealed` (New / Sealed)
- `'like_new'` → `like_new` (Complete in Box)
- `'used'` → `used` (Loose / Unboxed)
- `'stained_or_damaged'`, `'junk'` → `damaged_or_junk` (Scrap baseline)

---

### Query 4: Historical Time Series Buckets (SVG Charts)
Generates historical data points for the 30D / 90D / 1Y / ALL interactive charts:

```sql
-- 30-Day Window: 5-Day Buckets
SELECT 
    i.product_id,
    TO_CHAR(DATE_TRUNC('day', i."detectedAt"), 'YYYY-MM-DD') AS bucket_date,
    COUNT(*)::INT AS volume,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i."priceTotalEst"))::INT AS median_jpy,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i."priceTotalEst") FILTER (WHERE i."conditionGrade" = 'new_sealed'))::INT AS sealed_median,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i."priceTotalEst") FILTER (WHERE i."conditionGrade" = 'like_new'))::INT AS cib_median,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i."priceTotalEst") FILTER (WHERE i."conditionGrade" = 'used'))::INT AS loose_median
FROM "Item" i
WHERE i.status = 'sold'
  AND i."needsReview" = false
  AND i.product_id IS NOT NULL
  AND i."detectedAt" >= NOW() - INTERVAL '30 days'
GROUP BY i.product_id, DATE_TRUNC('day', i."detectedAt")
ORDER BY bucket_date ASC;
```

---

## 4. Output JSON Structure Mapping

The production export script iterates over the query results and populates `export.json`:

```json
{
  "version": "1.0.0",
  "pipelineStatus": "ready",
  "lastExportAt": "2026-10-25T18:00:00Z",
  "exchangeRateUsdJpy": 149.80,
  "exchangeRateDate": "2026-10-25",
  "platformsTracked": [
    "Mercari Japan",
    "Yahoo! Auctions Japan",
    "Rakuma",
    "Mandarake Kaitori & Archive",
    "Suruga-ya"
  ],
  "models": [
    {
      "slug": "<product.slug>",
      "canonicalSlug": "<franchise>/<series>/<product.slug>",
      "canonicalNameEn": "<product.canonical_name_en>",
      "canonicalNameJa": "<product.canonical_name_ja>",
      "romaji": "<product.romaji>",
      "aliases": ["<alias1>", "<alias2>"],
      "franchise": "<kamen_rider | ultraman>",
      "franchiseNameEn": "<Kamen Rider | Ultraman>",
      "series": "<series_key>",
      "seriesNameEn": "<Series Name>",
      "toyType": "<dx_belt | csm | replica | figure>",
      "manufacturer": "Bandai",
      "releaseYear": 2022,
      "originalMsrpJpy": 7920,
      "metrics": {
        "overall": {
          "medianPriceJpy": 8400,
          "medianPriceUsd": 56.08,
          "priceRangeMinJpy": 4500,
          "priceRangeMaxJpy": 13800,
          "soldVolume30d": 46,
          "soldVolume90d": 128,
          "priceTrendPct30d": 12.4,
          "averageSellHours": 38.5
        },
        "byCondition": {
          "new_sealed": {
            "medianPriceJpy": 12500,
            "medianPriceUsd": 83.44,
            "priceMinJpy": 11000,
            "priceMaxJpy": 14800,
            "soldVolume30d": 12
          },
          "like_new": {
            "medianPriceJpy": 8400,
            "medianPriceUsd": 56.08,
            "priceMinJpy": 7500,
            "priceMaxJpy": 9500,
            "soldVolume30d": 24
          },
          "used": {
            "medianPriceJpy": 4800,
            "medianPriceUsd": 32.04,
            "priceMinJpy": 3800,
            "priceMaxJpy": 5800,
            "soldVolume30d": 10
          },
          "damaged_or_junk": {
            "medianPriceJpy": 2200,
            "medianPriceUsd": 14.69,
            "soldVolume30d": 5,
            "note": "Floor parts value. Excluded from functional medians."
          }
        },
        "marketSpread": {
          "japanDomesticC2cMedianJpy": 8400,
          "japanShopBuybackFloorJpy": 5200,
          "westernEbayAvgUsd": 92.50,
          "arbitrageOpportunityUsd": 36.42
        }
      },
      "timeSeries": {
        "days30": [ ... ],
        "days90": [ ... ],
        "year1": [ ... ],
        "all": [ ... ]
      }
    }
  ]
}
```

---

## 5. Automation Cron Job (Wiring Instructions for Main Agent)

1. Save the export script on the production machine at `~/scripts/tokuprice-export.ts` (using `DATABASE_URL_RO` read-only connection string).
2. Configure crontab (`crontab -e`):
   ```cron
   # Daily at 03:00 JST (18:00 UTC)
   0 18 * * * cd /home/hatch/workspace/opportunity-factory/sites/tokuprice/site && npx tsx ~/scripts/tokuprice-export.ts && git commit -am "chore(data): automated daily sold price index export" && git push origin main
   ```
3. Pushing `data/export.json` automatically triggers the GitHub Actions workflow `deploy.yml`, rebuilding the static Astro site and deploying all updated model pages to GitHub Pages in ~45 seconds.
