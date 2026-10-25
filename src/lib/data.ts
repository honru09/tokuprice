import fs from 'node:fs';
import path from 'node:path';

export interface ConditionMetric {
  medianPriceJpy: number | null;
  medianPriceUsd: number | null;
  priceMinJpy?: number;
  priceMaxJpy?: number;
  soldVolume30d: number;
  note?: string;
}

export interface TimeSeriesPoint {
  date: string;
  medianJpy: number;
  volume: number;
  byGrade?: {
    sealed?: number | null;
    cib?: number | null;
    loose?: number | null;
  };
}

export interface ModelData {
  slug: string;
  canonicalSlug: string;
  canonicalNameEn: string;
  canonicalNameJa: string;
  romaji: string;
  aliases: string[];
  franchise: 'kamen_rider' | 'ultraman';
  franchiseNameEn: string;
  series: string;
  seriesNameEn: string;
  toyType: string;
  manufacturer: string;
  releaseYear: number;
  originalMsrpJpy: number;
  metrics: {
    overall: {
      medianPriceJpy: number;
      medianPriceUsd: number;
      priceRangeMinJpy: number;
      priceRangeMaxJpy: number;
      soldVolume30d: number;
      soldVolume90d: number;
      priceTrendPct30d: number;
      averageSellHours: number;
    };
    byCondition: {
      new_sealed: ConditionMetric;
      like_new: ConditionMetric;
      used: ConditionMetric;
      damaged_or_junk: ConditionMetric;
    };
    marketSpread: {
      japanDomesticC2cMedianJpy: number;
      japanShopBuybackFloorJpy: number;
      westernEbayAvgUsd: number;
      arbitrageOpportunityUsd: number;
    };
  };
  timeSeries: {
    days30: TimeSeriesPoint[];
    days90: TimeSeriesPoint[];
    year1: TimeSeriesPoint[];
    all: TimeSeriesPoint[];
  };
}

export interface ExportData {
  version: string;
  pipelineStatus: 'compiling' | 'ready' | 'degraded';
  pipelineMessage: string;
  lastExportAt: string;
  exchangeRateUsdJpy: number;
  exchangeRateDate: string;
  platformsTracked: string[];
  models: ModelData[];
}

let cachedData: ExportData | null = null;

export function getExportData(): ExportData {
  if (cachedData) return cachedData;

  const useFixtures = process.env.LOAD_FIXTURES === 'true' || import.meta.env.LOAD_FIXTURES === 'true';
  const dataFile = useFixtures
    ? path.resolve(process.cwd(), 'tests/fixtures/export-fixtures.json')
    : path.resolve(process.cwd(), 'data/export.json');

  try {
    const raw = fs.readFileSync(dataFile, 'utf-8');
    cachedData = JSON.parse(raw) as ExportData;
    return cachedData;
  } catch (err) {
    console.warn(`[data] Could not read ${dataFile}, returning empty schema:`, err);
    return {
      version: '1.0.0',
      pipelineStatus: 'compiling',
      pipelineMessage: 'Price index pipeline is compiling verified Tokyo sold data.',
      lastExportAt: new Date().toISOString(),
      exchangeRateUsdJpy: 149.80,
      exchangeRateDate: '2026-10-25',
      platformsTracked: ['Mercari Japan', 'Yahoo! Auctions Japan', 'Rakuma', 'Mandarake', 'Suruga-ya'],
      models: []
    };
  }
}

export function getAllModels(): ModelData[] {
  return getExportData().models;
}

export function getModelsByFranchise(franchiseKey: string): ModelData[] {
  const norm = franchiseKey.replace('-', '_');
  return getAllModels().filter(m => m.franchise === norm);
}

export function getModelByCanonical(franchiseKey: string, seriesKey: string, slugKey: string): ModelData | undefined {
  const normFranchise = franchiseKey.replace('-', '_');
  return getAllModels().find(
    m => m.franchise === normFranchise && m.series === seriesKey && m.slug === slugKey
  );
}

// Design.md §3.3 Numeric Formatting Rules:
// "No Hand-Rolled Currency Formats: All currency figures must render through
//  Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 })
//  and Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })."
const jpyFormatter = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0
});

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatJpy(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || isNaN(amount)) return '—';
  return jpyFormatter.format(amount);
}

export function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || isNaN(amount)) return '—';
  return usdFormatter.format(amount);
}

export function formatTrend(pct: number | null | undefined): { text: string; isPositive: boolean; isNegative: boolean } {
  if (pct === null || pct === undefined || isNaN(pct)) {
    return { text: '0.0%', isPositive: false, isNegative: false };
  }
  const sign = pct > 0 ? '+' : '';
  return {
    text: `${sign}${pct.toFixed(1)}%`,
    isPositive: pct > 0,
    isNegative: pct < 0
  };
}
