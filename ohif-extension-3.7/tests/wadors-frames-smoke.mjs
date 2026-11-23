import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { syntheticDicomFiles } from './synthetic-dicom.mjs';

// Run against the production dist inside the pinned OHIF checkout. The host's
// own dcmjs reads only the generated in-memory fixture. No archive is contacted.
if (!process.argv[2]) throw new Error('Pass the pinned OHIF checkout\'s platform/app/dist directory.');
const dist = resolve(process.argv[2]);
await stat(resolve(dist, 'index.html'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISFRANC_PLAYWRIGHT || 'playwright');
const dcmjs = require(require.resolve('dcmjs', { paths: [dist] }));
const file = syntheticDicomFiles('multiframe')[0].buffer;
const dataset = dcmjs.data.DicomMessage.readFile(file.buffer.slice(file.byteOffset, file.byteOffset + file.length)).dict;
const pixels = Buffer.from(dataset['7FE00010'].Value[0]);
delete dataset['7FE00010'];
const study = dataset['0020000D'].Value[0];
const series = dataset['0020000E'].Value[0];
const sop = dataset['00080018'].Value[0];
const frameBytes = dataset['00280010'].Value[0] * dataset['00280011'].Value[0];
assert.equal(pixels.length, 2 * frameBytes);
const frames = [pixels.subarray(0, frameBytes), pixels.subarray(frameBytes)];
const hashes = frames.map(data => createHash('sha256').update(data).digest('hex'));
assert.notEqual(hashes[0], hashes[1]);
const metadata = Object.fromEntries(Object.entries(dataset).map(([tag, { vr, Value }]) => [
  tag, { vr, Value: vr === 'PN' ? Value.map(Alphabetic => ({ Alphabetic })) : Value },
]));
const studyTags = ['00080020', '00080030', '00081030', '00100010', '00100020', '0020000D'];
const studyResult = Object.fromEntries(studyTags.map(tag => [tag, metadata[tag]]));
const studyPath = '/dicomweb/studies/' + study;
const framePath = studyPath + '/series/' + series + '/instances/' + sop + '/frames/';
const apiRoot = '/api/lisfranc-clinical/v1/studies';
const apiStudy = apiRoot + '/' + study;
const readRoutes = new Map([
  [apiRoot, { studies: [{ studyUID: study, reviewCount: 0, correctedCount: 0 }] }],
  [apiStudy + '/reviews', { reviews: [] }],
  [apiStudy + '/claim', { claim: null }],
  ...[1, 2].map(n => [apiStudy + '/frames/' + series + '/' + sop + '/' + n, { review: null }]),
]);
const mime = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const requests = [];
let origin;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, origin).pathname;
  const reply = (type, body) => res.writeHead(200, { 'Content-Type': type }).end(body);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (path === '/app-config.js') {
    const root = origin + '/dicomweb';
    const config = {
      routerBasename: '/', extensions: [], modes: [], showStudyList: false,
      showWarningMessageForCrossOrigin: false, showCPUFallbackMessage: false,
      maxNumberOfWebWorkers: 2, defaultDataSourceName: 'dicomweb',
      dataSources: [{
        namespace: '@ohif/extension-default.dataSourcesModule.dicomweb', sourceName: 'dicomweb',
        configuration: {
          friendlyName: 'Loopback generated frames', name: 'synthetic', wadoRoot: root,
          wadoUriRoot: root, qidoRoot: root, imageRendering: 'wadors', thumbnailRendering: 'wadors',
          enableStudyLazyLoad: false,
        },
      }],
    };
    return reply('application/javascript', 'window.config=' + JSON.stringify(config) + ';');
  }
  if (path === '/dicomweb/studies') return reply('application/dicom+json', JSON.stringify([studyResult]));
  if (path === studyPath + '/metadata') return reply('application/dicom+json', JSON.stringify([metadata]));
  if (path === framePath + '1' || path === framePath + '2') {
    const n = Number(path.slice(-1));
    requests.push(n);
    const boundary = 'SyntheticFrameBoundary';
    const part = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Type: application/octet-stream\r\n\r\n'),
      frames[n - 1], Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    return reply('multipart/related; type="application/octet-stream"; boundary="' + boundary + '"', part);
  }
  if (readRoutes.has(path)) return reply('application/json', JSON.stringify(readRoutes.get(path)));
  const asset = resolve(dist, path === '/viewer/dicomweb' ? 'index.html' : '.' + path);
  const entry = asset.startsWith(dist + sep) && await stat(asset).catch(() => null);
  if (!entry?.isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': mime[extname(asset)] || 'application/octet-stream' });
  createReadStream(asset).on('error', () => res.destroy()).pipe(res);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.LISFRANC_BROWSER_EXECUTABLE || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  for (let run = 0; run < 2; run++) {
    const context = await browser.newContext({ viewport: { width: 1450, height: 950 }, serviceWorkers: 'block' });
    const failures = [];
    // The stock viewer requests external fonts. Keep the harness entirely local.
    await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.stack || error.message));
    const firstRequest = requests.length;
    await page.goto(origin + '/viewer/dicomweb?StudyInstanceUIDs=' + study);
    const connect = page.getByRole('button', { name: 'Open Clinical reviews', exact: true });
    const panel = page.locator('[data-cy="lisfranc-btn"]');
    await connect.or(panel).filter({ visible: true }).first().waitFor();
    if (!await connect.isVisible()) await panel.click();
    await connect.click();
    let requestsAfterFirstPass;
    for (const [step, n] of [1, 2, 1, 2].entries()) {
      await page.getByTestId('lisfranc-clinical-case').filter({ hasText: 'Frame ' + n + ' ' }).click();
      await page.getByTestId('lisfranc-frame').filter({ hasText: new RegExp('^Frame ' + n + '$') }).waitFor();
      const actual = await page.evaluate(async () => {
        const grid = window.services.viewportGridService;
        const viewport = window.services.cornerstoneViewportService.getCornerstoneViewport(grid.getActiveViewportId());
        const image = viewport.getCornerstoneImage();
        async function hash(values) {
          if (!values.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error('Invalid grayscale samples');
          const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(values));
          return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
        }
        return {
          selectedId: viewport.getCurrentImageId(), loadedId: image.imageId,
          decoded: await hash(image.getPixelData()), displayed: await hash(viewport.getImageData().scalarData),
        };
      });
      assert.equal(actual.selectedId, 'wadors:' + origin + framePath + n);
      assert.equal(actual.loadedId, actual.selectedId);
      assert.equal(actual.decoded, hashes[n - 1], 'Decoded pixels for frame ' + n);
      assert.equal(actual.displayed, hashes[n - 1], 'Viewport scalars for frame ' + n);
      if (step === 1) requestsAfterFirstPass = requests.length;
    }
    assert.deepEqual(new Set(requests.slice(firstRequest)), new Set([1, 2]), 'Both WADO-RS frame endpoints were used');
    assert.equal(requests.length, requestsAfterFirstPass, 'Both revisits used cached frames');
    assert.deepEqual(failures, []);
    await context.close();
  }
  console.log('PASS WADO-RS: two fresh browser contexts, both frame endpoints, Clinical frame labels, loaded image IDs, all decoded pixels and all viewport scalars on each revisit.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
