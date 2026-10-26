#!/usr/bin/env node
/**
 * check-curation.mjs — verify the curation overlay is complete and safe.
 *
 * Checks:
 *  1. Every model-<hash> fallback slug in data/export.json has a disposition
 *     in data/curation.json (no silent drops).
 *  2. Actions are valid; keep entries carry names + newSlug; merge entries
 *     point at an existing export slug that itself survives (keep / hold /
 *     uncurated — never another merge or an exclusion).
 *  3. No duplicate newSlugs, and no newSlug collides with a slug that keeps
 *     its current URL.
 *  4. Every renamed/merged old slug has a static redirect page under
 *     public/, pointing at the target's final URL, and that target slug is
 *     in the final model set.
 *  5. If dist/ exists, every redirect target has a built page and excluded
 *     slugs have no built page.
 *
 * Run:  npm run check:curation
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));

const exportData = readJson('data/export.json');
const curationRaw = readJson('data/curation.json');
const curation = {};
for (const [k, v] of Object.entries(curationRaw)) {
  if (!k.startsWith('_')) curation[k] = v;
}

const failures = [];
const fail = (msg) => failures.push(msg);

const models = exportData.models;
const bySlug = new Map(models.map((m) => [m.slug, m]));
const franchisePath = (m) => m.franchise.replace('_', '-');
const canonicalOf = (m, slug) => `${franchisePath(m)}/${m.series}/${slug}`;

// 1. All fallback slugs disposed
const hashSlugs = models.filter((m) => m.slug.startsWith('model-')).map((m) => m.slug);
for (const slug of hashSlugs) {
  if (!curation[slug]) fail(`missing disposition for fallback slug ${slug}`);
}

// 2. Action validity + merge targets survive
const ACTIONS = new Set(['keep', 'merge_into', 'exclude_lot', 'hold']);
for (const [slug, entry] of Object.entries(curation)) {
  if (!bySlug.has(slug)) fail(`curation key ${slug} is not an export slug`);
  if (!ACTIONS.has(entry.action)) fail(`${slug}: invalid action ${entry.action}`);
  if (entry.action === 'keep') {
    if (!entry.canonicalNameEn || !entry.canonicalNameJaClean || !entry.newSlug) {
      fail(`${slug}: keep requires canonicalNameEn, canonicalNameJaClean, newSlug`);
    }
  }
  if (entry.action === 'merge_into') {
    if (!entry.mergeInto || !bySlug.has(entry.mergeInto)) {
      fail(`${slug}: mergeInto '${entry.mergeInto}' is not an export slug`);
    } else {
      const targetAction = curation[entry.mergeInto]?.action;
      if (targetAction === 'merge_into' || targetAction === 'exclude_lot') {
        fail(`${slug}: merge target ${entry.mergeInto} does not survive (action ${targetAction})`);
      }
    }
  }
}

// 3. newSlug uniqueness / collisions
const newSlugs = new Map();
for (const [slug, entry] of Object.entries(curation)) {
  if (entry.action !== 'keep' || !entry.newSlug) continue;
  if (newSlugs.has(entry.newSlug)) {
    fail(`duplicate newSlug ${entry.newSlug} (${newSlugs.get(entry.newSlug)} and ${slug})`);
  }
  newSlugs.set(entry.newSlug, slug);
}
const survivingSlugs = new Set(
  models
    .filter((m) => {
      const a = curation[m.slug]?.action;
      return !a || a === 'hold';
    })
    .map((m) => m.slug)
);
for (const ns of newSlugs.keys()) {
  if (survivingSlugs.has(ns)) fail(`newSlug ${ns} collides with a surviving slug`);
}

// Final model set (original data -> slug after overlay)
const finalSlugOf = (originalSlug) => {
  const entry = curation[originalSlug];
  if (!entry || entry.action === 'hold') return originalSlug;
  if (entry.action === 'keep') return entry.newSlug ?? originalSlug;
  return null; // merged or excluded: no page of its own
};
const finalModels = new Map();
for (const m of models) {
  const fsSlug = finalSlugOf(m.slug);
  if (fsSlug) finalModels.set(fsSlug, canonicalOf(m, fsSlug));
}

// 4. Redirect pages
let redirectCount = 0;
for (const m of models) {
  const entry = curation[m.slug];
  if (!entry) continue;
  let expectedTarget = null;
  if (entry.action === 'keep' && entry.newSlug && entry.newSlug !== m.slug) {
    expectedTarget = canonicalOf(m, entry.newSlug);
  } else if (entry.action === 'merge_into' && entry.mergeInto) {
    const targetModel = bySlug.get(entry.mergeInto);
    const targetSlug = finalSlugOf(entry.mergeInto);
    if (targetModel && targetSlug) expectedTarget = canonicalOf(targetModel, targetSlug);
  }
  if (!expectedTarget) continue;
  redirectCount += 1;
  if (!finalModels.has(expectedTarget.split('/').pop())) {
    fail(`${m.slug}: redirect target slug not in final model set (${expectedTarget})`);
  }
  const redirectFile = path.join(root, 'public', canonicalOf(m, m.slug), 'index.html');
  if (!fs.existsSync(redirectFile)) {
    fail(`${m.slug}: missing redirect page public/${canonicalOf(m, m.slug)}/index.html`);
    continue;
  }
  const html = fs.readFileSync(redirectFile, 'utf-8');
  if (!html.includes(`url=/${expectedTarget}/`) && !html.includes(`"${'/'}${expectedTarget}/"`)) {
    if (!html.includes(`/${expectedTarget}/`)) {
      fail(`${m.slug}: redirect page does not point at /${expectedTarget}/`);
    }
  }
}

// 5. dist cross-check (when a build exists)
const distDir = path.join(root, 'dist');
if (fs.existsSync(distDir)) {
  for (const canonical of finalModels.values()) {
    if (!fs.existsSync(path.join(distDir, canonical, 'index.html'))) {
      fail(`dist: final model page missing for ${canonical}`);
    }
  }
  for (const m of models) {
    if (curation[m.slug]?.action === 'exclude_lot') {
      const page = path.join(distDir, canonicalOf(m, m.slug), 'index.html');
      if (fs.existsSync(page)) fail(`dist: excluded slug ${m.slug} still has a page`);
    }
  }
}

const counts = { keep: 0, merge_into: 0, exclude_lot: 0, hold: 0 };
for (const slug of hashSlugs) {
  const a = curation[slug]?.action;
  if (a && counts[a] !== undefined) counts[a] += 1;
}
console.log(
  `Fallback slugs: ${hashSlugs.length}; dispositions among them: keep=${counts.keep} merge=${counts.merge_into} exclude=${counts.exclude_lot} hold=${counts.hold}`
);
console.log(`Redirect pages expected: ${redirectCount}`);
if (failures.length) {
  console.error(`\nFAIL (${failures.length}):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('check:curation OK');
