import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { syntheticDicomFiles } from './synthetic-dicom.mjs';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:38612/');
assert.equal(base.protocol, 'http:', 'This harness runs against the isolated HTTP staging fixture.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a loopback fixture only.');
assert.ok(!base.search && !base.hash && !base.username && !base.password, 'Pass the OHIF base URL.');
if (!base.pathname.endsWith('/')) base.pathname += '/';

const passwordA = process.env.LISFRANC_TEST_PASSWORD_A;
const passwordB = process.env.LISFRANC_TEST_PASSWORD_B;
assert.ok(passwordA && passwordB && passwordA !== passwordB, 'Supply isolated fixture Basic Auth passwords.');
const apiPrefix = '/api/lisfranc-clinical/v1';
const studyUID = '2.25.250981981353660330135830176371284000300';
const studyPath = apiPrefix + '/studies/' + studyUID;
const clinicalPrefix = 'lisfranc-ohif-review/v1/';
const demoPrefix = 'lisfranc-ohif-demo-reviews/v1/';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISFRANC_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.LISFRANC_BROWSER_EXECUTABLE || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const cli = (page, id) => page.getByTestId('lisfranc-' + id);

function waitText(locator, pattern) {
  return locator.filter({ hasText: pattern }).waitFor();
}

async function openViewer(page) {
  const response = await page.goto(new URL('localbasic', base).href);
  assert.equal(response?.status(), 200);
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(syntheticDicomFiles('multiframe'));
  await page.waitForURL(url => url.pathname.endsWith('/viewer/dicomlocal'));
  const tabs = page.getByRole('tablist', { name: 'Lisfranc workspace' });
  const panelTab = page.locator('[data-cy="lisfranc-btn"]');
  await tabs.or(panelTab).filter({ visible: true }).first().waitFor();
  if (!await tabs.isVisible()) await panelTab.click();
  return tabs;
}

async function openClinical(page, frameNumber) {
  const tabs = await openViewer(page);
  await button(page, 'Open Clinical reviews').click();
  await cli(page, 'clinical-queue').waitFor();
  if (frameNumber && await cli(page, 'frame').innerText() !== 'Frame ' + frameNumber) {
    await cli(page, 'clinical-case').filter({ hasText: new RegExp('Frame ' + frameNumber + '(?: |$)') }).click();
    await waitText(cli(page, 'frame'), new RegExp('^Frame ' + frameNumber + '$'));
  }
  return tabs;
}

function waitWrite(page) {
  return page.waitForResponse(response => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === 'PUT' &&
      pathname.startsWith(studyPath + '/frames/');
  });
}

async function save(page, action) {
  const pending = waitWrite(page);
  await action();
  const response = await pending;
  assert.ok(response.ok(), 'Expected the clinical database to acknowledge the review.');
  const { review } = await response.json();
  assert.ok(review?.revision > 0);
  return review;
}

async function placeLandmarks(page) {
  await button(page, 'Edit landmarks').click();
  const overlay = cli(page, 'overlay');
  const box = await overlay.boundingBox();
  assert.ok(box && box.width > 50 && box.height > 50);
  for (const [name, x, y] of [
    ['C1 proximal', 0.43, 0.55], ['C1 distal', 0.50, 0.48], ['M2 tangent', 0.56, 0.57],
  ]) {
    await button(page, name).click();
    await save(page, () => overlay.click({ position: { x: x * box.width, y: y * box.height } }));
  }
  const draft = await save(page, () => page.getByLabel('Cortex relation', { exact: true }).selectOption('separated'));
  await waitText(cli(page, 'tangent'), /\d\s*px\b/);
  return draft;
}

async function savedEntries(page, prefix) {
  return page.evaluate(prefix => Object.fromEntries(
    Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort().map(key => [key, localStorage.getItem(key)]),
  ), prefix);
}

async function readStudy(page) {
  const response = await page.request.get(new URL(studyPath + '/reviews', base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).reviews;
}

async function readClaim(page) {
  const response = await page.request.get(new URL(studyPath + '/claim', base).href);
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
const demoApiRequests = [];

async function reviewer(username, password) {
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
    outsideRequests.push(url.origin);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  return page;
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
  const draft = await placeLandmarks(alice);
  assert.equal(draft.status, 'draft');
  assert.equal(await aliceCorrected.innerText(), 'Corrected (0)');
  await waitText(cli(alice, 'study-claim'), /You are editing this study/);
  assert.equal((await readClaim(alice)).holder, 'fixture-alice');
  await openClinical(bob, draft.frame.frameNumber);
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
  const bobTabs = await openClinical(bob, draft.frame.frameNumber);
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

  const reopened = await save(bob, () => button(bob, 'Reopen').click());
  assert.equal(reopened.status, 'draft');
  assert.equal(reopened.updatedBy, 'fixture-bob');
  assert.deepEqual(reopened.points, approved.points);
  await button(alice, 'Refresh shared queue').click();
  await waitText(aliceCorrected, /^Corrected \(0\)$/);
  await waitText(bobCorrected, /^Corrected \(0\)$/);
  assert.equal((await readStudy(alice))[0].revision, reopened.revision);
  assert.equal((await readClaim(alice)).holder, 'fixture-bob');
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
  const authRequired = await anonymous.request.get(new URL(studyPath + '/reviews', base).href);
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

  assert.deepEqual(demoApiRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(outsideRequests, []);
  console.log('PASS demo stays browser-local, isolated from other profiles and the clinical database');
} finally {
  for (const error of pageErrors) console.error('Workspace page error:', error);
  await browser.close();
}
