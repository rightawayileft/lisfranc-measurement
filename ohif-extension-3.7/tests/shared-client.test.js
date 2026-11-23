import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudyLease } from '../workspaces/clinical/lease.js';
import { createSharedReviewStore, sharedStudyHref } from '../workspaces/clinical/shared.js';

const frame = {
  studyUID: '2.25.100', seriesUID: '2.25.101', sopUID: '2.25.102', frameNumber: 2,
  columns: 256, rows: 256, view: 'ap', supportedModality: true, spacing: null,
};
const record = {
  frame, revision: 3, points: { c1_proximal: { x: 1, y: 2 } },
  status: 'draft', relation: null, viewSource: 'dicom_ap', spacing: null,
};
const prefix = '/api/lisfranc-clinical/v1';
const path = prefix + '/studies/2.25.100/frames/2.25.101/2.25.102/2';
const claimPath = prefix + '/studies/2.25.100/claim';
const leaseId = '2e3f7e80-7be6-4d57-90f9-a1727d982f45';
const claim = { holder: 'reviewer-a', expiresAt: '2026-11-18T12:00:00Z' };
const response = payload => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });

test('shared frame persistence uses its exact DICOM identity and the acknowledged revision', async () => {
  const calls = [];
  const store = createSharedReviewStore(async (url, options) => {
    calls.push({ url, options });
    return response({ review: options.method === 'PUT' ? { ...record, revision: 4 } : record });
  });
  assert.deepEqual(await store.get(frame), record);
  const injected = { ...frame, patientName: 'discarded', actor: 'discarded' };
  assert.equal((await store.put(injected, { ...record, actor: 'discarded' }, leaseId)).revision, 4);
  assert.equal(calls[0].url, path);
  assert.equal(calls[1].url, path);
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.mode, 'same-origin');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls[1].options.redirect, 'error');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    baseRevision: 3, frame, points: record.points,
    relation: null, status: 'draft', viewSource: 'dicom_ap', spacing: null,
  });
  assert.deepEqual(Object.keys(calls[1].options.headers).sort(), ['Accept', 'Content-Type', 'X-Lisfranc-Lease']);
  assert.equal(calls[1].options.headers['X-Lisfranc-Lease'], leaseId);
});

test('shared store reports a write conflict and never retries or follows an alternate route', async () => {
  let writes = 0;
  const store = createSharedReviewStore(async () => {
    writes++;
    return new Response('', { status: 409 });
  });
  await assert.rejects(() => store.put(frame, record, leaseId), failure => failure.status === 409 && /Reload/.test(failure.message));
  assert.equal(writes, 1);
  await assert.rejects(() => store.get({ ...frame, sopUID: '..' }), /valid DICOM image/);
  assert.equal(writes, 1);
});

test('claim credentials stay in memory and travel only to the shared service paths', async () => {
  const calls = [];
  const store = createSharedReviewStore(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/history')) return response({ history: [record] });
    return response({ claim: options.method === 'DELETE' ? null : claim });
  });
  await assert.rejects(() => store.put(frame, record), failure => failure.code === 'claim_required');
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.getClaim(frame.studyUID), claim);
  assert.deepEqual(await store.claim(frame.studyUID, leaseId), claim);
  assert.equal(await store.release(frame.studyUID, leaseId, { keepalive: true }), null);
  assert.deepEqual(await store.history(frame), [record]);
  assert.equal(calls[0].url, claimPath);
  assert.deepEqual(JSON.parse(calls[1].options.body), { leaseId });
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[2].url, claimPath);
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(calls[2].options.headers['X-Lisfranc-Lease'], leaseId);
  assert.equal(calls[2].options.keepalive, true);
  assert.equal(calls[3].url, path + '/history');
});

test('lease releases only once an in-flight frame save is acknowledged', async () => {
  const calls = [];
  const store = {
    claim: async () => claim,
    release: async (uid, id) => { calls.push(['release', uid, id]); return null; },
  };
  const manager = createStudyLease(store, frame.studyUID, { newId: () => leaseId });
  await manager.acquire();
  assert.equal(manager.current().held, true);
  let finishWrite;
  const paused = new Promise(resolve => { finishWrite = resolve; });
  const saving = manager.run(async id => {
    assert.equal(id, leaseId);
    await paused;
    calls.push(['acknowledged']);
    return record;
  });
  const releasing = manager.release();
  assert.equal(manager.current().held, false);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishWrite();
  assert.deepEqual(await saving, record);
  await releasing;
  assert.deepEqual(calls, [['acknowledged'], ['release', frame.studyUID, leaseId]]);
  assert.deepEqual(manager.current(), { claim: null, held: false, busy: false, retryClaim: false, error: null });
});

test('an uncertain renewal disables editing and a retry uses the same in-memory lease', async () => {
  const ids = [];
  const store = {
    async claim(uid, id) {
      ids.push(id);
      if (ids.length === 2) throw Object.assign(new Error('fixture network failure'), { status: 0 });
      return claim;
    },
    async getClaim() { return claim; },
  };
  let clock = 50;
  const manager = createStudyLease(store, frame.studyUID, { newId: () => leaseId, now: () => clock });
  await manager.acquire();
  clock += 111_000;
  await assert.rejects(() => manager.acquire(), /fixture network failure/);
  assert.equal(manager.current().held, false);
  assert.equal(manager.current().retryClaim, true);
  await manager.observe();
  assert.equal(manager.current().held, false, 'Observation cannot prove that this browser holds the lease.');
  await manager.acquire();
  assert.equal(manager.current().held, true);
  assert.deepEqual(ids, [leaseId, leaseId, leaseId]);
});

test('shared study list rejects an out-of-study record and malformed summary counts', async () => {
  const store = createSharedReviewStore(async url => response(url === prefix + '/studies'
    ? { studies: [{ studyUID: frame.studyUID, correctedCount: 3, reviewCount: 2 }] }
    : { reviews: [{ ...record, frame: { ...frame, studyUID: '2.25.999' } }] }));
  await assert.rejects(() => store.listStudy(frame.studyUID), /invalid study queue/);
  await assert.rejects(() => store.listStudies(), /invalid shared queue/);
});

test('shared study links are limited to a configured same-origin OHIF path', () => {
  assert.equal(sharedStudyHref(frame.studyUID, '/ohif/viewer/dicomweb'), '/ohif/viewer/dicomweb?StudyInstanceUIDs=2.25.100');
  for (const path of [undefined, '//external.invalid', 'https://external.invalid', '/ohif/../viewer', '/ohif/viewer?extra=1', '/ohif/viewer#other']) {
    assert.equal(sharedStudyHref(frame.studyUID, path), null);
  }
});
