import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISFRANC_PLAYWRIGHT || 'playwright');
const defaultPath = fileURLToPath(new URL('./Lisfranc-Review.html', import.meta.url));
const path = resolve(process.argv[2] ?? defaultPath);
const browser = await chromium.launch({ executablePath: process.env.LISFRANC_BROWSER_EXECUTABLE });
const button = (scope, name) => scope.getByRole('button', { name, exact: typeof name === 'string' });

async function exported(page, name) {
  const pending = page.waitForEvent('download');
  await button(page, name).click();
  const file = await pending;
  return readFile(await file.path(), 'utf8');
}

async function addLocal(page, ap, lateral) {
  await button(page, 'Add local images').click();
  const picker = page.getByRole('dialog', { name: 'Add local images' });
  await picker.getByLabel('AP image files').setInputFiles(ap);
  if (lateral) await picker.getByLabel('Lateral image (for a single AP)').setInputFiles(lateral);
  await button(picker, 'Open local images').click();
  return picker;
}

async function fixture(page, name, level) {
  const base64 = await page.evaluate(level => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(' + level + ' ' + level + ' ' + level + ')';
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = '#b0b0b0';
    context.fillRect(90, 120, 60, 60);
    return canvas.toDataURL('image/png').split(',')[1];
  }, level);
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function openCase(page, name) {
  await button(page, name).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  const guide = page.getByRole('dialog', { name: 'Quick review guide' });
  if (await guide.isVisible()) await button(guide, 'Start reviewing').click();
  const viewport = page.getByTestId('dicom-viewport');
  await viewport.locator('.splash').waitFor({ state: 'hidden' });
  return viewport;
}

try {
  const context = await browser.newContext({
    offline: true, serviceWorkers: 'block', acceptDownloads: true,
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
  await page.getByRole('heading', { name: 'Review worklist', exact: true }).waitFor();

  const bundled = await page.evaluate(async () => {
    const data = window.PORTABLE_DATA;
    async function inspect(entry) {
      const image = new Image();
      image.src = entry.image;
      await image.decode();
      const [source, encoded] = entry.image.split(',');
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        source,
        dimensions: [image.naturalWidth, image.naturalHeight],
        declared: [entry.width, entry.height],
        view: entry.view,
        hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        declaredHash: entry.sha256,
      };
    }
    return {
      fingerprint: data.fingerprint,
      proposals: data.proposals.length,
      rows: await Promise.all(data.cases.map(async entry => ({
        label: entry.label,
        frames: await Promise.all((entry.frames ?? [entry]).map(inspect)),
      }))),
    };
  });
  assert.equal(bundled.proposals, 0);
  assert.equal(bundled.rows.length, 15);
  const frames = bundled.rows.flatMap(row => row.frames);
  assert.equal(frames.length, 25);
  assert.equal(new Set(frames.map(frame => frame.hash)).size, 25);
  for (const frame of frames) {
    assert.match(frame.source, /^data:image\/(?:jpeg|png);base64$/);
    assert.deepEqual(frame.dimensions, frame.declared);
    assert.equal(frame.hash, frame.declaredHash);
  }
  for (const row of bundled.rows) {
    if (/^UNIFESP pair /.test(row.label)) {
      assert.deepEqual(row.frames.map(frame => frame.view), ['ap', 'lateral']);
    } else {
      assert.match(row.label, /^HVAngleEst example /);
      assert.deepEqual(row.frames.map(frame => frame.view), ['ap']);
    }
    await button(page, row.label).waitFor();
  }
  assert.equal(await page.locator('tr[data-case-id]').count(), bundled.rows.length);
  assert.equal(bundled.rows.filter(row => row.label.startsWith('UNIFESP pair ')).length, 10);
  assert.equal(bundled.rows.filter(row => row.label.startsWith('HVAngleEst example ')).length, 5);
  await button(page, 'Guide').click();
  const sourceGuide = page.getByRole('dialog', { name: 'Quick review guide' });
  await sourceGuide.getByText('Image sources', { exact: true }).click();
  assert.match(await sourceGuide.innerText(), /UNIFESP/);
  assert.match(await sourceGuide.innerText(), /HVAngleEst/);
  assert.equal(await sourceGuide.getByRole('link', { name: 'Source dataset' }).count(), 2);
  assert.equal(await sourceGuide.getByRole('link', { name: 'License' }).count(), 2);
  await button(sourceGuide, 'Start reviewing').click();
  const pair = await openCase(page, 'UNIFESP pair 01');
  await page.locator('.view-thumb').filter({ hasText: /LATERAL/ }).click();
  await pair.locator('.splash').waitFor({ state: 'hidden' });
  await page.locator('.view-thumb.selected').filter({ hasText: /LATERAL/ }).waitFor();
  await button(page, 'Worklist').click();
  await page.getByRole('heading', { name: 'Review worklist', exact: true }).waitFor();
  assert.equal(Object.keys(JSON.parse(await exported(page, 'Export reviews')).reviews).length, 0);

  const first = await fixture(page, 'test-ap-one.png', 96);
  const second = await fixture(page, 'test-ap-two.png', 110);
  const invalid = await addLocal(page, { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('<html>test</html>') });
  await invalid.getByRole('alert').getByText('Select JPEG or PNG radiographs.').waitFor();
  await button(invalid, 'Cancel').click();
  assert.equal(await page.locator('tr[data-case-id]').count(), bundled.rows.length);

  const badPair = await addLocal(page, [first, second], first);
  await badPair.getByRole('alert').getByText('Pair a lateral image with exactly one AP image.').waitFor();
  await button(badPair, 'Cancel').click();

  await (await addLocal(page, [first, second])).waitFor({ state: 'hidden' });
  await button(page, 'Local case 2').waitFor();
  assert.equal(await page.locator('tr[data-case-id]').count(), 2);
  const viewport = await openCase(page, 'Local case 1');
  const box = await viewport.boundingBox();
  for (const [name, x, y] of [
    [/C1 proximal/, 0.46, 0.60], [/C1 distal/, 0.46, 0.44], [/M2 tangent/, 0.53, 0.52],
  ]) {
    await button(page, name).click();
    await viewport.click({ position: { x: x * box.width, y: y * box.height } });
  }
  await button(page, /^Separated$/i).click();
  await page.locator('.save-status').getByText('Saved', { exact: true }).waitFor();
  const draft = JSON.parse(await exported(page, 'Export reviews'));
  assert.match(draft.fingerprint, /^local-raster-v1-[a-f0-9]{64}$/);
  assert.equal(draft.images.length, 2);
  assert.deepEqual(draft.images.map(image => image.display_image_sha256),
    [first, second].map(file => createHash('sha256').update(file.buffer).digest('hex')));
  assert.deepEqual(draft.images.map(image => image.view), ['ap', 'ap']);
  const [saved] = Object.values(draft.reviews);
  assert.equal(saved.status, 'draft');
  assert.equal(saved.measurements.tangent.unsigned_mm, null);
  const { c1_proximal: a, c1_distal: b, m2_tangent: c } = saved.points;
  const expected = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(expected > 0);
  assert.ok(Math.abs(saved.measurements.tangent.unsigned_px - expected) < 0.00001);
  assert.doesNotMatch(JSON.stringify(draft), /data:image|blob:|test-ap/);

  await button(page, bundled.rows.length ? 'Open bundled examples' : 'Clear local images').click();
  await page.getByRole('heading', { name: 'Review worklist', exact: true }).waitFor();
  const clean = JSON.parse(await exported(page, 'Export reviews'));
  assert.equal(clean.fingerprint, bundled.fingerprint);
  assert.deepEqual(clean.reviews, {});
  await (await addLocal(page, [first, second])).waitFor({ state: 'hidden' });
  await button(page, 'Local case 2').waitFor();
  const restored = JSON.parse(await exported(page, 'Export reviews'));
  assert.deepEqual(restored.reviews, draft.reviews);
  const csv = await exported(page, 'CSV');
  assert.match(csv, /^case_id,workflow,status,signed_px,unsigned_px\r?\n1,assisted,draft,/);
  assert.doesNotMatch(csv, /data:image|blob:|test-ap/);

  await (await addLocal(page, first, second)).waitFor({ state: 'hidden' });
  await openCase(page, 'Local case 1');
  await page.locator('.view-thumb').filter({ hasText: /LATERAL/ }).waitFor();
  const paired = JSON.parse(await exported(page, 'Export reviews'));
  assert.notEqual(paired.fingerprint, draft.fingerprint);
  assert.deepEqual(paired.images.map(image => image.view), ['ap', 'lateral']);
  assert.deepEqual(paired.reviews, {});

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS offline demo with ' + frames.length + ' bundled radiographs, local raster validation, AP batch and lateral pairing, pixel geometry, separate review collections, and JSON/CSV export without image bytes.');
} finally {
  await browser.close();
}
