import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { syntheticDicomFiles, syntheticFramePixels } from './synthetic-dicom.mjs';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:38612/');
assert.equal(base.protocol, 'http:', 'This harness runs against the isolated HTTP staging fixture.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a loopback fixture only.');
assert.ok(!base.search && !base.hash && !base.username && !base.password, 'Pass the OHIF base URL.');
if (!base.pathname.endsWith('/')) base.pathname += '/';

const passwordA = process.env.LISFRANC_TEST_PASSWORD_A;
const passwordB = process.env.LISFRANC_TEST_PASSWORD_B;
assert.ok(passwordA && passwordB && passwordA !== passwordB, 'Supply isolated fixture Basic Auth passwords.');
const apiPrefix = '/api/lisfranc-clinical/v1';
const studyUID = '2.25.250981981353660330135830176371284000400';
const legacyMultiframeUID = '2.25.250981981353660330135830176371284000300';
const calibratedUID = '2.25.250981981353660330135830176371284000100';
const nonEnrolledUID = '2.25.250981981353660330135830176371284000200';
const studyPath = uid => apiPrefix + '/studies/' + uid;
const clinicalPrefix = 'lisfranc-ohif-review/v1/';
const demoPrefix = 'lisfranc-ohif-demo-reviews/v1/';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISFRANC_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.LISFRANC_BROWSER_EXECUTABLE || undefined,
  args: [
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--host-resolver-rules=MAP fonts.gstatic.com ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND',
  ],
});

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const cli = (page, id) => page.getByTestId('lisfranc-' + id);

function waitText(locator, pattern) {
  return locator.filter({ hasText: pattern }).waitFor();
}

async function openViewer(page, kind = 'stack') {
  const response = await page.goto(new URL('localbasic', base).href);
  assert.equal(response?.status(), 200);
  const files = syntheticDicomFiles(kind);
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(['stack', 'multiframe'].includes(kind) ? files : files.slice(0, 1));
  await page.waitForURL(url => url.pathname.endsWith('/viewer/dicomlocal'));
  const tabs = page.getByRole('tablist', { name: 'Lisfranc workspace' });
  const panelTab = page.locator('[data-cy="lisfranc-btn"]');
  await tabs.or(panelTab).filter({ visible: true }).first().waitFor();
  if (!await tabs.isVisible()) await panelTab.click();
  const associations = await tabs.evaluate(element =>
    Array.from(element.querySelectorAll('[role="tab"]'), tab => {
      const control = tab.getAttribute('aria-controls');
      const target = document.getElementById(control);
      return {
        tab: tab.textContent, control, tag: target?.tagName,
        role: target?.getAttribute('role') ?? null,
        labelledByTab: target?.getAttribute('aria-labelledby') === tab.id,
      };
    }),
  );
  assert.equal(associations.length, 2);
  assert.ok(associations[0].control && associations[1].control);
  assert.notEqual(associations[0].control, associations[1].control);
  assert.deepEqual(associations.map(({ control: _control, ...attributes }) => attributes), [
    { tab: 'Clinical', tag: 'DIV', role: 'tabpanel', labelledByTab: true },
    { tab: 'Demo', tag: 'DIALOG', role: null, labelledByTab: false },
  ]);
  return tabs;
}

async function openClinical(page, kind = 'stack') {
  const tabs = await openViewer(page, kind);
  await button(page, 'Open Clinical reviews').click();
  await cli(page, 'clinical-queue').waitFor();
  return tabs;
}

function imageRow(page, ordinal) {
  return cli(page, 'clinical-case').filter({ hasText: new RegExp('^Image ' + ordinal + ' ') });
}

async function selectImage(page, ordinal) {
  const row = imageRow(page, ordinal);
  await row.click();
  await row.and(page.locator('[aria-current="true"]')).waitFor();
}

async function assertDecodedPixels(page, ordinal) {
  // Distinct stripes are both visually and numerically verifiable, independently of imageId.
  const offsets = [48, 96, 128, 176].map(x => 80 * 256 + x);
  const actual = await page.evaluate(offsets => {
    const { viewportGridService, cornerstoneViewportService } = window.services;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportGridService.getActiveViewportId());
    const image = viewport.getCornerstoneImage();
    const pixels = image.getPixelData();
    return { count: pixels.length, samples: offsets.map(offset => pixels[offset]) };
  }, offsets);
  const expected = syntheticFramePixels(ordinal);
  assert.deepEqual(actual, { count: expected.length, samples: offsets.map(offset => expected[offset]) });
}

function waitWrite(page, uid) {
  return page.waitForResponse(response => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === 'PUT' &&
      pathname.startsWith(studyPath(uid) + '/frames/');
  });
}

async function save(page, action, uid = studyUID) {
  const pending = waitWrite(page, uid);
  await action();
  const response = await pending;
  assert.ok(response.ok(), 'Expected the clinical database to acknowledge the review.');
  const { review } = await response.json();
  assert.ok(review?.revision > 0);
  return review;
}

async function placeLandmarks(page, { uid = studyUID, unit = 'px' } = {}) {
  await button(page, 'Edit landmarks').click();
  const overlay = cli(page, 'overlay');
  const box = await overlay.boundingBox();
  assert.ok(box && box.width > 50 && box.height > 50);
  const points = [
    ['C1 proximal', 0.43, 0.55], ['C1 distal', 0.50, 0.48], ['M2 tangent', 0.56, 0.57],
  ];
  if (unit === 'mm') points.push(['M2 proximal', 0.53, 0.61], ['M2 distal', 0.60, 0.59]);
  for (const [name, x, y] of points) {
    await button(page, name).click();
    await save(page, () => overlay.click({ position: { x: x * box.width, y: y * box.height } }), uid);
  }
  const draft = await save(page, () => page.getByLabel('Cortex relation', { exact: true }).selectOption('separated'), uid);
  await waitText(cli(page, 'tangent'), new RegExp('\\d\\s*' + unit + '\\b'));
  assert.equal(draft.frame.studyUID, uid);
  if (unit === 'px') assert.equal(draft.spacing, null);
  return draft;
}

async function savedEntries(page, prefix) {
  return page.evaluate(prefix => Object.fromEntries(
    Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort().map(key => [key, localStorage.getItem(key)]),
  ), prefix);
}

async function readStudy(page, uid = studyUID) {
  const response = await page.request.get(new URL(studyPath(uid) + '/reviews', base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).reviews;
}

async function readClaim(page) {
  const response = await page.request.get(new URL(studyPath(studyUID) + '/claim', base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).claim;
}

async function expectClaimReleased(page) {
  const deadline = Date.now() + 5000;
  do {
    if (await readClaim(page) === null) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  assert.fail('Approval did not release the study claim.');
}

async function openDemo(page, tabs) {
  await tabs.getByRole('tab', { name: 'Demo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Demo workspace', exact: true });
  await dialog.waitFor();
  const demo = dialog.frameLocator('iframe[title="Lisfranc demo review"]');
  await demo.getByRole('heading', { name: 'Review worklist', exact: true }).waitFor();
  assert.equal(await demo.locator('tr[data-case-id]').count(), 15);
  await button(demo, 'HVAngleEst example 05').waitFor();
  await button(demo, 'Add local images').waitFor();
  return { dialog, demo };
}

async function editDemoReview(demo) {
  await button(demo, 'UNIFESP pair 01').click();
  await demo.getByRole('heading', { name: 'UNIFESP pair 01', exact: true }).waitFor();
  const guide = demo.getByRole('dialog', { name: 'Quick review guide' });
  if (await guide.isVisible()) await button(guide, 'Start reviewing').click();
  await demo.locator('.view-thumb').filter({ hasText: /LATERAL/ }).click();
  await demo.locator('.view-thumb.selected').filter({ hasText: /LATERAL/ }).waitFor();
  await demo.locator('.view-thumb').filter({ hasText: /^AP/ }).click();
  const viewport = demo.getByTestId('dicom-viewport');
  await viewport.locator('.splash').waitFor({ state: 'hidden' });
  const box = await viewport.boundingBox();
  assert.ok(box);
  await demo.getByRole('button', { name: /C1 proximal/ }).click();
  await viewport.click({ position: { x: box.width * 0.46, y: box.height * 0.60 } });
  await waitText(demo.locator('.save-status'), /^Saved$/);
}

const pageErrors = [];
const outsideRequests = [];
const bundledFontRequests = [];
const stockFont = 'https://fonts.googleapis.com/css?family=Inter:100,300,400,500,700&display=swap';
const demoApiRequests = [];
const legacyNativeErrors = [];

async function reviewer(username, password, legacy = false) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block',
    ...(username && { httpCredentials: { username, password, origin: base.origin } }),
  });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base.origin || ['blob:', 'data:'].includes(url.protocol)) {
      if (url.pathname.startsWith(apiPrefix) && request.frame().parentFrame()) demoApiRequests.push(url.pathname);
      return route.continue();
    }
    if (request.method() === 'GET' && url.href === stockFont) bundledFontRequests.push(url.href);
    else outsideRequests.push(url.href);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => {
    if (legacy && error.message === 'frame exceeds size of pixelData') legacyNativeErrors.push(error.message);
    else pageErrors.push(error.message);
  });
  return page;
}

async function verifyLegacyMultiframeIsReadOnly() {
  const page = await reviewer('fixture-alice', passwordA, true);
  const putRequests = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && pathname.startsWith(studyPath(legacyMultiframeUID) + '/')) {
      putRequests.push(pathname);
    }
  });
  await openViewer(page, 'multiframe');
  await button(page, 'Open Clinical reviews').click();
  const unavailable = page.getByText(/Local and WADO-URI multi-frame images are unavailable/);
  await unavailable.waitFor();

  const offsets = [48, 96, 128, 176].map(x => 80 * 256 + x);
  const expected = [1, 2].map(ordinal => {
    const pixels = syntheticFramePixels(ordinal);
    return offsets.map(offset => pixels[offset]);
  });
  await page.waitForFunction(() => {
    const services = window.services;
    const id = services?.viewportGridService.getActiveViewportId();
    return services?.cornerstoneViewportService.getCornerstoneViewport(id)?.getImageIds().length === 2;
  });
  // These are initial and repeated native stack selections. The v3.7 host does
  // not expose its private WADO-URI data-set cache for deterministic eviction.
  const visits = await page.evaluate(async ({ offsets, expected }) => {
    const { viewportGridService, cornerstoneViewportService } = window.services;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportGridService.getActiveViewportId());
    const ids = viewport.getImageIds();
    const visits = [];
    for (const index of [0, 1, 0, 1]) {
      try {
        // The legacy decoder can throw before settling its returned promise.
        let timer;
        try {
          await Promise.race([
            viewport.setImageIdIndex(index),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('native decode did not settle')), 2500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const rendered = viewport.getCornerstoneImage();
        if (!rendered || rendered.imageId !== ids[index]) {
          visits.push({ frame: index + 1, result: 'not rendered' });
          continue;
        }
        const pixels = rendered.getPixelData();
        const correct = offsets.every((offset, i) => pixels[offset] === expected[index][i]);
        visits.push({ frame: index + 1, result: correct ? 'matching pixels' : 'different pixels' });
      } catch (error) {
        visits.push({ frame: index + 1, result: error?.message ?? String(error) });
      }
    }
    return visits;
  }, { offsets, expected });
  assert.deepEqual(visits.map(visit => visit.frame), [1, 2, 1, 2]);
  assert.ok(visits.some(visit => ['matching pixels', 'different pixels'].includes(visit.result)),
    'Read actual decoded pixels for at least one native frame.');
  assert.ok(visits.every(visit => ['not rendered', 'matching pixels', 'different pixels',
    'frame exceeds size of pixelData', 'native decode did not settle'].includes(visit.result)), JSON.stringify(visits));
  assert.ok(await unavailable.isVisible());
  assert.equal(await button(page, 'Edit landmarks').count(), 0);
  assert.equal(await cli(page, 'overlay').count(), 0);
  assert.equal((await readStudy(page, legacyMultiframeUID)).length, 0);
  assert.deepEqual(await savedEntries(page, clinicalPrefix), {});
  assert.deepEqual(putRequests, []);
  console.log('PASS legacy local multi-frame is blocked after native viewport activity and revisits: ' +
    visits.map(visit => 'frame ' + visit.frame + ' ' + visit.result).join(', ') +
    '. Native bounds errors: ' + legacyNativeErrors.length + '.');
}

try {
  const alice = await reviewer('fixture-alice', passwordA);
  const bob = await reviewer('fixture-bob', passwordB);
  const signIn = await alice.request.get(new URL(apiPrefix + '/sign-in', base).href);
  assert.equal(signIn.status(), 200);
  assert.match(await signIn.text(), /Clinical sign-in complete/);
  const aliceTabs = await openClinical(alice);
  const aliceCorrected = cli(alice, 'clinical-folder-corrected');
  await waitText(aliceCorrected, /^Corrected \(0\)$/);
  await selectImage(alice, 1);
  await assertDecodedPixels(alice, 1);
  const draft = await placeLandmarks(alice);
  assert.equal(draft.status, 'draft');
  assert.equal(await aliceCorrected.innerText(), 'Corrected (0)');
  await waitText(cli(alice, 'study-claim'), /You are editing this study/);
  assert.equal((await readClaim(alice)).holder, 'fixture-alice');
  await openClinical(bob);
  await selectImage(bob, 1);
  const bobCorrected = cli(bob, 'clinical-folder-corrected');
  await waitText(cli(bob, 'status'), /^Draft.*shared queue/i);
  await waitText(cli(bob, 'study-claim'), /Claimed by fixture-alice/);
  assert.ok(await button(bob, 'Edit landmarks').isDisabled(), 'Another reader cannot edit a claimed study.');
  assert.ok(await button(bob, 'Approve').isDisabled(), 'Another reader cannot approve a claimed study.');
  assert.equal((await readStudy(bob))[0].revision, draft.revision);

  const approved = await save(alice, () => button(alice, 'Approve').click());
  assert.equal(approved.status, 'approved');
  assert.equal(approved.updatedBy, 'fixture-alice');
  assert.deepEqual(approved.points, draft.points);
  await waitText(aliceCorrected, /^Corrected \(1\)$/);
  assert.equal((await readStudy(bob))[0].revision, approved.revision);
  await expectClaimReleased(bob);
  const bobTabs = await openClinical(bob);
  await bobCorrected.click();
  await selectImage(bob, 1);
  await waitText(cli(bob, 'status'), /^Approved.*shared queue/i);
  assert.equal(await bob.getByLabel('Cortex relation', { exact: true }).inputValue(), 'separated');
  assert.deepEqual((await readStudy(alice))[0].points, approved.points);

  await button(bob, 'Refresh shared queue').click();
  await waitText(bobCorrected, /^Corrected \(1\)$/);
  assert.equal((await readStudy(bob)).length, 1, 'Approval must not affect the other frame.');
  const globalCorrected = cli(bob, 'shared-corrected');
  await waitText(globalCorrected, /Corrected[^0-9]*1/i);
  await button(bob, 'History').click();
  await waitText(cli(bob, 'frame-history'), /Approved.*fixture-alice/i);
  console.log('PASS shared study claim blocks competing edits, approval transfers the queue and records the reviewer');

  await cli(bob, 'clinical-folder-to-review').click();
  await selectImage(bob, 2);
  await assertDecodedPixels(bob, 2);
  await waitText(cli(bob, 'frame'), /^Frame 1$/);
  await waitText(cli(bob, 'status'), /^Not started$/);
  assert.equal((await readStudy(bob)).length, 1);
  await bobCorrected.click();
  await selectImage(bob, 1);
  await assertDecodedPixels(bob, 1);
  await waitText(cli(bob, 'status'), /^Approved.*shared queue/i);
  console.log('PASS two SOPs in one stack have separate review state and correct decoded pixels');

  const reopened = await save(bob, () => button(bob, 'Reopen').click());
  assert.equal(reopened.status, 'draft');
  assert.equal(reopened.updatedBy, 'fixture-bob');
  assert.deepEqual(reopened.points, approved.points);
  await button(alice, 'Refresh shared queue').click();
  await waitText(aliceCorrected, /^Corrected \(0\)$/);
  await waitText(bobCorrected, /^Corrected \(0\)$/);
  assert.equal((await readStudy(alice))[0].revision, reopened.revision);
  assert.equal((await readClaim(alice)).holder, 'fixture-bob');
  await button(bob, 'History').click();
  await waitText(cli(bob, 'frame-history'), /Draft.*fixture-bob/i);
  await waitText(cli(bob, 'frame-history'), /Approved.*fixture-alice/i);
  assert.deepEqual(await savedEntries(alice, clinicalPrefix), {});
  assert.deepEqual(await savedEntries(bob, clinicalPrefix), {});
  console.log('PASS reopening updates both clinical folders with no locally persisted clinical review');

  const demoA = await openDemo(alice, aliceTabs);
  assert.deepEqual(await savedEntries(alice, demoPrefix), {});
  await editDemoReview(demoA.demo);
  assert.equal(Object.keys(await savedEntries(alice, demoPrefix)).length, 1);
  const demoB = await openDemo(bob, bobTabs);
  assert.deepEqual(await savedEntries(bob, demoPrefix), {});
  await button(demoB.dialog, 'Back to Clinical').click();
  assert.equal((await readStudy(bob))[0].revision, reopened.revision);

  const anonymous = await reviewer();
  const authRequired = await anonymous.request.get(new URL(studyPath(studyUID) + '/reviews', base).href);
  assert.equal(authRequired.status(), 401);
  assert.match(authRequired.headers()['www-authenticate'], /^Basic /);
  assert.equal((await anonymous.request.get(new URL(apiPrefix + '/sign-in', base).href)).status(), 401);
  const guestClinicalRequests = [];
  anonymous.on('request', request => {
    if (new URL(request.url()).pathname.startsWith(apiPrefix)) guestClinicalRequests.push(request.url());
  });
  const guestTabs = await openViewer(anonymous);
  await openDemo(anonymous, guestTabs);
  assert.deepEqual(guestClinicalRequests, [], 'Opening Demo must not initiate any Clinical authentication requests.');
  assert.deepEqual(await savedEntries(anonymous, clinicalPrefix), {});
  console.log('PASS named Basic Auth protects clinical data while Demo opens without a clinical sign-in');

  const metric = await reviewer('fixture-alice', passwordA);
  await openClinical(metric, 'calibrated');
  const metricReview = await placeLandmarks(metric, { uid: calibratedUID, unit: 'mm' });
  assert.deepEqual(metricReview.spacing, {
    row_mm: 0.25, col_mm: 0.5, source: 'DICOM Pixel Spacing (GEOMETRY)',
  });
  const { c1_proximal: a, c1_distal: b, m2_tangent: q, m2_proximal: c, m2_distal: d } = metricReview.points;
  const dx = (b.x - a.x) * 0.5;
  const dy = (b.y - a.y) * 0.25;
  const distance = point =>
    Math.abs(dx * (point.y - a.y) * 0.25 - dy * (point.x - a.x) * 0.5) / Math.hypot(dx, dy);
  assert.ok(distance(q) > 0);
  assert.equal(await cli(metric, 'tangent').innerText(), 'Parallel tangent: +' + distance(q).toFixed(2) + ' mm');
  const midpoint = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
  assert.ok(distance(midpoint) > 0);
  assert.match(await cli(metric, 'proxy').innerText(),
    new RegExp('^Midpoint proxy: ' + distance(midpoint).toFixed(2).replace('.', '\\.') + ' mm\\b'));
  assert.equal((await readStudy(metric, calibratedUID)).length, 1);
  assert.equal((await readStudy(metric)).length, 1);

  const denied = await metric.request.get(new URL(studyPath(nonEnrolledUID) + '/reviews', base).href);
  assert.equal(denied.status(), 404, 'Authenticated readers must not see an unenrolled study.');
  console.log('PASS calibrated anisotropic millimeters, pixel-only fallback, and unenrolled study isolation');

  await verifyLegacyMultiframeIsReadOnly();

  assert.deepEqual(demoApiRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(outsideRequests, []);
  console.log('Blocked ' + bundledFontRequests.length + ' fetches of the stock OHIF font stylesheet before network.');
  console.log('PASS demo stays browser-local, isolated from other profiles and the clinical database');
} finally {
  for (const error of pageErrors) console.error('Workspace page error:', error);
  await browser.close();
}
