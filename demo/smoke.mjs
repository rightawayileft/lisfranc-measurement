import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISFRANC_PLAYWRIGHT || 'playwright');
const defaultPath = fileURLToPath(new URL('./Lisfranc-Review.html', import.meta.url));
const path = resolve(process.argv[2] ?? defaultPath);
const browser = await chromium.launch({ executablePath: process.env.LISFRANC_BROWSER_EXECUTABLE });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const label = 'Synthetic paired case 01';
const caseHeading = (page, name) => page.getByRole('heading', { name, exact: true });

async function exported(page, name) {
  const pending = page.waitForEvent('download');
  await button(page, name).click();
  const file = await pending;
  return readFile(await file.path(), 'utf8');
}

try {
  const context = await browser.newContext({
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: true,
    viewport: { width: 1450, height: 980 },
  });
  const external = [];
  await context.route(/https?:\/\//, route => {
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.goto(pathToFileURL(path).href);
  await caseHeading(page, 'Review worklist').waitFor();
  await button(page, label).waitFor();
  assert.equal(await page.locator('tr[data-case-id]').count(), 10);
  assert.ok(await page.getByText(/Synthetic foot projection schematics/).isVisible());

  const images = await page.evaluate(async () => {
    const frames = window.PORTABLE_DATA.cases.flatMap(item => item.frames);
    if (window.PORTABLE_DATA.synthetic_demo !== true) throw new Error('Expected a generated demo');
    return Promise.all(frames.map(async frame => {
      const image = new Image();
      image.src = frame.image;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, view: frame.view };
    }));
  });
  assert.equal(images.length, 20);
  assert.equal(images.filter(item => item.view === 'ap').length, 10);
  assert.ok(images.every(item => item.width === 256 && item.height === 256));

  await button(page, 'Guide').click();
  const guide = page.getByRole('dialog', { name: 'Quick review guide' });
  await guide.getByText('Source & draft information').click();
  assert.match(await guide.innerText(), /Ten generated fixtures/);
  assert.doesNotMatch(await guide.innerText(), /UNIFESP|HVAngleEst|Astra/);
  await button(guide, 'Start reviewing').click();
  await button(page, label).click();
  await caseHeading(page, label).waitFor();
  await page.locator('.view-thumb.selected').filter({ hasText: /AP/ }).waitFor();

  await button(page, 'Review Dorsal soft tissue').click();
  await page.locator('.view-thumb.selected').filter({ hasText: 'LATERAL' }).waitFor();
  await page.getByTestId('dicom-viewport').locator('.splash').waitFor({ state: 'hidden' });
  const handle = page.getByTestId('finding-soft_tissue-0').locator('circle').last();
  await handle.hover();
  const box = await handle.boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.down();
  await page.mouse.move(x + 27, y - 11, { steps: 5 });
  await page.mouse.up();
  await page.locator('.save-status').getByText('Saved', { exact: true }).waitFor();
  const draft = JSON.parse(await exported(page, 'Export reviews'));
  assert.ok(draft.fingerprint.startsWith('synthetic-'));
  assert.equal(draft.images.length, 20);
  assert.ok(draft.images.every(image => /^portable-synthetic-foot-/.test(image.image_id)));
  const [saved] = Object.values(draft.reviews);
  assert.equal(saved.status, 'draft');
  assert.notDeepEqual(saved.clinical_findings.measurements.soft_tissue.points[0], { x: 145, y: 145 });
  assert.deepEqual(saved.clinical_findings.measurements.soft_tissue.points[1], { x: 144, y: 134 });
  assert.equal(saved.measurements.tangent.unsigned_mm, null);
  assert.ok(saved.measurements.tangent.unsigned_px > 0);

  await page.reload();
  await caseHeading(page, label).waitFor();
  const restored = JSON.parse(await exported(page, 'Export reviews'));
  assert.deepEqual(restored.reviews, draft.reviews, 'Reload should retain the local edit.');
  await button(page, 'Back to worklist').click();
  const csv = await exported(page, 'CSV');
  assert.match(csv, /case_id,workflow,status,signed_px,unsigned_px/);
  assert.match(csv, /^1,assisted,draft,/m);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS offline file: 10 AP/lateral pairs, 20 decoded PNGs, synthetic Guide, drag, autosave, reload, JSON/CSV, pixel-only distances, and no network requests.');
} finally {
  await browser.close();
}
