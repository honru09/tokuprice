#!/usr/bin/env node
/**
 * generate-redirects.mjs — static redirect pages for curated slug changes.
 *
 * Reads data/export.json + data/curation.json and writes one redirect page
 * per renamed (keep + newSlug) or merged (merge_into) model into
 * public/<franchise>/<series>/<oldSlug>/index.html. GitHub Pages serves
 * that file at the old URL; it meta-refreshes (and JS-replaces) to the
 * model's final URL. Generated files are committed on purpose — the check
 * script (scripts/check-curation.mjs) verifies they exist and point at a
 * target that will be built.
 *
 * Re-run after any curation.json change:  npm run generate:redirects
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exportData = JSON.parse(fs.readFileSync(path.join(root, 'data/export.json'), 'utf-8'));
const curationRaw = JSON.parse(fs.readFileSync(path.join(root, 'data/curation.json'), 'utf-8'));
const curation = {};
for (const [k, v] of Object.entries(curationRaw)) {
  if (!k.startsWith('_')) curation[k] = v;
}

const franchisePath = (m) => m.franchise.replace('_', '-');
const bySlug = new Map(exportData.models.map((m) => [m.slug, m]));

function finalCanonical(originalSlug) {
  const model = bySlug.get(originalSlug);
  if (!model) return null;
  const entry = curation[originalSlug];
  const slug = entry?.action === 'keep' && entry.newSlug ? entry.newSlug : originalSlug;
  return `/${franchisePath(model)}/${model.series}/${slug}/`;
}

let written = 0;
for (const model of exportData.models) {
  const entry = curation[model.slug];
  if (!entry) continue;
  let target = null;
  if (entry.action === 'keep' && entry.newSlug && entry.newSlug !== model.slug) {
    target = finalCanonical(model.slug);
  } else if (entry.action === 'merge_into' && entry.mergeInto) {
    target = finalCanonical(entry.mergeInto);
  }
  if (!target) continue;

  const relDir = path.join(
    'public',
    franchisePath(model),
    model.series,
    model.slug
  );
  const absDir = path.join(root, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Moved — TokuPrice</title>
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="https://tokuprice.com${target}" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <script>window.location.replace(${JSON.stringify(target)});</script>
  </head>
  <body>
    <p>This model has moved to <a href="${target}">${target}</a>.</p>
  </body>
</html>
`;
  fs.writeFileSync(path.join(absDir, 'index.html'), html);
  written += 1;
  console.log(`redirect /${franchisePath(model)}/${model.series}/${model.slug}/ -> ${target}`);
}
console.log(`Wrote ${written} redirect page(s).`);
