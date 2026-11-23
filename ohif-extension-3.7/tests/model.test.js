import assert from 'node:assert/strict';
import test from 'node:test';
import { compute, footOfPerpendicular, formatDistance } from '../workspaces/clinical/geometry.js';
import {
  canApprove, clinicalFolders, createReviewStore, emptyReview, exportCSV, exportJSON, frameKey, STORAGE_PREFIX,
} from '../workspaces/clinical/review.js';

// Analytic coordinates and UIDs created solely for these tests.
const points = {
  c1_proximal: { x: 0, y: 0 },
  c1_distal: { x: 10, y: 10 },
  m2_tangent: { x: 10, y: 4 },
  m2_proximal: { x: 6, y: 0 },
  m2_distal: { x: 10, y: 4 },
};
const spacing = { row_mm: 2, col_mm: 1, source: 'DICOM PixelSpacing' };
const frame = {
  studyUID: '2.25.101', seriesUID: '2.25.102', sopUID: '2.25.103', frameNumber: 1,
  rows: 32, columns: 32,
};

function near(actual, expected, tolerance = 1e-9) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} � ${expected}`);
}

function mockStorage() {
  const storage = new Map();
  return {
    get length() { return storage.size; },
    key: index => [...storage.keys()][index] ?? null,
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
}

test('tangent, optional midpoint proxy and geometry foot apply anisotropic spacing', () => {
  const preview = compute(points, 'overlap', spacing);
  assert.equal(preview.tangentStatus, 'complete');
  assert.equal(preview.proxyStatus, 'complete');
  near(preview.unsignedPx, 6 / Math.SQRT2);
  near(preview.signedPx, -6 / Math.SQRT2);
  near(preview.unsignedMm, 12 / Math.sqrt(5));
  near(preview.signedMm, -12 / Math.sqrt(5));
  near(preview.proxyUnsignedPx, 6 / Math.SQRT2);
  near(preview.proxyUnsignedMm, 12 / Math.sqrt(5));
  near(preview.proxyAngleDeg, 0, 1e-6);
  const foot = footOfPerpendicular(points.c1_proximal, points.c1_distal, points.m2_tangent, 1, 2);
  near(foot.x, 5.2);
  near(foot.y, 5.2);
  assert.equal(formatDistance(preview.signedMm, preview.signedPx, true), '-5.37 mm');
});

test('only explicit, finite positive spacing produces metric results', () => {
  for (const calibration of [null, { row_mm: 0, col_mm: 1 }, { row_mm: 2, col_mm: NaN }]) {
    const preview = compute(points, 'separated', calibration);
    assert.equal(preview.unsignedMm, null);
    assert.equal(preview.signedMm, null);
    assert.equal(preview.proxyUnsignedMm, null);
    assert.equal(formatDistance(preview.signedMm, preview.signedPx, true), '+4.2 px');
  }
  const preview = compute(points, 'unknown', { row_mm: 1, col_mm: 1 });
  assert.equal(preview.signedPx, null);
  assert.equal(preview.signedMm, null);
  assert.equal(preview.unsignedMm, preview.unsignedPx);
});

test('approval follows tangent validity, explicit relation and optional proxy completeness', () => {
  const draft = { ...emptyReview(), points, relation: 'unknown' };
  const { m2_tangent, m2_distal, m2_proximal, ...c1 } = points;
  assert.equal(canApprove(draft), true);
  assert.equal(canApprove({ ...draft, relation: null }), false);
  assert.equal(canApprove({ ...draft, points: { ...c1, m2_tangent, m2_proximal } }), false);
  assert.equal(canApprove({ ...draft, points: { ...c1, m2_tangent } }), true);
  assert.equal(canApprove({ ...draft, points: { ...c1, m2_distal, m2_proximal } }), false);
  assert.equal(compute({ ...points, c1_distal: { x: 0.5, y: 0 } }, 'overlap').tangentStatus, 'invalid');
  assert.equal(compute({ ...points, c1_distal: { x: 0.5, y: 0 } }, 'overlap').proxyStatus, 'invalid');
  assert.equal(compute({ ...points, m2_distal: m2_proximal }, 'overlap').proxyAngleDeg, null);
});

test('coincident M2 corners invalidate only the optional midpoint proxy and block approval', () => {
  const duplicate = { ...points, m2_distal: { ...points.m2_proximal } };
  const preview = compute(duplicate, 'overlap', spacing);
  assert.equal(preview.tangentStatus, 'complete');
  assert.equal(preview.proxyStatus, 'invalid');
  assert.equal(preview.proxyInvalidReason, 'coincident_m2_corners');
  assert.equal(preview.proxyUnsignedPx, null);
  assert.equal(preview.proxyUnsignedMm, null);
  assert.equal(preview.proxyAngleDeg, null);
  assert.equal(canApprove({ ...emptyReview(), points: duplicate, relation: 'overlap', spacing }), false);
  const distinct = { ...duplicate, m2_distal: { x: duplicate.m2_distal.x + 0.125, y: duplicate.m2_distal.y } };
  assert.equal(compute(distinct, 'overlap', spacing).proxyStatus, 'complete');
});

test('reload, study and frame isolation, and stale-tab edits', () => {
  const storage = mockStorage();
  const firstTab = createReviewStore(storage);
  const secondTab = createReviewStore(storage);
  const nextFrame = { ...frame, frameNumber: 2 };
  const otherStudy = { ...frame, studyUID: '2.25.1010' };
  const newReview = { ...emptyReview(), points, relation: 'separated' };

  assert.equal(frameKey({ ...frame, frameNumber: 0 }), null);
  assert.equal(frameKey({ ...frame, frameNumber: '1' }), null);
  assert.equal(firstTab.get(frame), null);
  const saved = firstTab.put(frame, newReview);
  assert.deepEqual(secondTab.get(frame), saved);
  assert.equal(secondTab.get(nextFrame), null);
  assert.equal(secondTab.get(otherStudy), null);
  assert.throws(() => secondTab.put(frame, newReview), /changed in another tab/);
  secondTab.put(nextFrame, { ...newReview, status: 'skipped' });
  secondTab.put(otherStudy, { ...newReview, status: 'rejected' });
  assert.deepEqual(firstTab.exportStudy(frame.studyUID).map(r => [r.frame.frameNumber, r.status]), [
    [1, 'draft'], [2, 'skipped'],
  ]);
});

test('approval and rejection require reopening, and malformed writes preserve saved points', () => {
  const store = createReviewStore(mockStorage());
  const newReview = { ...emptyReview(), points, relation: 'overlap', status: 'approved' };
  assert.throws(() => store.put(frame, { ...newReview, relation: null }), /Approval requires/);
  const approved = store.put(frame, newReview);
  const edited = { ...points, m2_tangent: { x: 15, y: 5 } };
  assert.throws(() => store.put(frame, { ...approved, status: 'draft', points: edited }), /Return this review to draft/);
  const draft = store.put(frame, { ...approved, status: 'draft' });
  const updated = store.put(frame, { ...draft, points: edited });
  assert.deepEqual(updated.points.m2_tangent, edited.m2_tangent);
  assert.throws(() => store.put(frame, { ...updated, points: { m2_tangent: { x: 32, y: 1 } } }), /outside the image/);
  assert.deepEqual(store.get(frame), updated);
});

test('exports include frame identity and coordinates with no image payload and blank unavailable metric fields', () => {
  const store = createReviewStore(mockStorage());
  const review = { ...emptyReview(), points, relation: 'overlap', status: 'approved' };
  store.put(frame, { ...review, image: 'fixture-only-unexpected-field' });
  store.put({ ...frame, frameNumber: 2 }, { ...review, spacing });
  const records = store.exportStudy(frame.studyUID);
  const jsonText = exportJSON(records.map(record => ({ ...record, image: 'fixture-only-unexpected-field' })));
  assert.doesNotMatch(jsonText, /fixture-only-unexpected-field/);
  const json = JSON.parse(jsonText);
  assert.equal(json.reviews[0].measurements.tangent.unsigned_mm, null);
  assert.equal(json.reviews[1].frame.frameNumber, 2);
  assert.equal(json.reviews[1].measurements.tangent.method_id, 'parallel_tangent_distance_v0');
  assert.equal(json.reviews[1].measurements.proxy.method_id, 'four_point_midpoint_proxy_v0');
  near(json.reviews[1].measurements.tangent.signed_mm, -12 / Math.sqrt(5));

  const [header, ...lines] = exportCSV(records).trimEnd().split('\r\n');
  const field = (row, name) => lines[row].split(',')[header.split(',').indexOf(name)];
  assert.equal(field(0, 'tangent_signed_mm'), '');
  assert.equal(field(0, 'spacing_source'), '');
  assert.equal(field(1, 'spacing_source'), 'DICOM PixelSpacing');
  assert.equal(field(1, 'frame_number'), '2');
  near(Number(field(1, 'tangent_signed_mm')), -12 / Math.sqrt(5));
});

test('a corrupt browser record is surfaced without being overwritten', () => {
  const storage = mockStorage();
  const key = `${STORAGE_PREFIX}${frameKey(frame)}`;
  storage.setItem(key, '{');
  const store = createReviewStore(storage);
  assert.throws(() => store.get(frame), /unreadable/);
  assert.throws(() => store.put(frame, emptyReview()), /unreadable/);
  assert.equal(storage.getItem(key), '{');
});

test('existing reviews retain their original units during status changes and edits', () => {
  const store = createReviewStore(mockStorage());
  const draft = { ...emptyReview(), points, relation: 'separated', status: 'approved' };
  const calibrated = store.put(frame, { ...draft, spacing });
  const reopened = store.put({ ...frame, spacing: null }, { ...calibrated, spacing: null, status: 'draft' });
  assert.deepEqual(reopened.spacing, spacing);
  near(JSON.parse(exportJSON([reopened])).reviews[0].measurements.tangent.unsigned_mm, 12 / Math.sqrt(5));

  const second = { ...frame, frameNumber: 2 };
  const uncalibrated = store.put(second, { ...draft, status: 'draft' });
  const edited = store.put({ ...second, spacing }, { ...uncalibrated, spacing, status: 'approved' });
  assert.equal(edited.spacing, null);
});

test('manually confirmed AP view survives readback and study export', () => {
  const store = createReviewStore(mockStorage());
  store.put(frame, {
    ...emptyReview(), points, relation: 'separated', viewSource: 'reviewer_confirmed_ap',
  });
  assert.equal(store.get(frame).viewSource, 'reviewer_confirmed_ap');
  const rows = store.exportStudy(frame.studyUID);
  assert.equal(JSON.parse(exportJSON(rows)).reviews[0].viewSource, 'reviewer_confirmed_ap');
  const [header, row] = exportCSV(rows).trimEnd().split('\r\n');
  assert.equal(row.split(',')[header.split(',').indexOf('view_source')], 'reviewer_confirmed_ap');
});

test('legacy approvals with coincident proxy corners remain exportable and can be corrected', () => {
  const storage = mockStorage();
  const store = createReviewStore(storage);
  const approved = store.put(frame, { ...emptyReview(), points, relation: 'separated', status: 'approved' });
  const legacy = { ...approved, points: { ...points, m2_distal: points.m2_proximal } };
  delete legacy.viewSource;
  storage.setItem(`${STORAGE_PREFIX}${frameKey(frame)}`, JSON.stringify(legacy));

  const restored = store.get(frame);
  assert.equal(restored.status, 'approved');
  assert.equal(restored.viewSource, null);
  const exported = JSON.parse(exportJSON(store.exportStudy(frame.studyUID))).reviews[0];
  assert.equal(exported.measurements.proxy.status, 'invalid');
  assert.equal(exported.measurements.proxy.unsigned_px, null);
  const reopened = store.put(frame, { ...restored, status: 'draft' });
  assert.throws(() => store.put(frame, { ...reopened, status: 'approved' }), /Approval requires/);
  assert.equal(store.put(frame, { ...reopened, points, status: 'approved' }).status, 'approved');
});

test('clinical folder movement follows the saved approval of each frame', () => {
  const storage = mockStorage();
  const store = createReviewStore(storage);
  const ap = { ...frame, supportedModality: true, view: 'ap' };
  const nextFrame = { ...ap, frameNumber: 2 };
  const lateral = { ...ap, sopUID: '2.25.987', view: 'non_ap' };
  const otherStudy = { ...ap, studyUID: '2.25.789' };
  const frames = [ap, nextFrame, lateral, otherStudy]
    .map((frame, stackIndex) => ({ frame, stackIndex, imageId: `synthetic:${stackIndex}` }));
  const reloadFolders = () => {
    const { reviews } = createReviewStore(storage).listStudy(ap.studyUID);
    return clinicalFolders(ap.studyUID, frames, reviews);
  };

  const draft = store.put(ap, { ...emptyReview(), points, relation: 'separated' });
  store.put(otherStudy, { ...emptyReview(), points, relation: 'separated', status: 'approved' });
  const pending = reloadFolders();
  assert.deepEqual(pending.toReview.map(row => row.key), [frameKey(ap), frameKey(nextFrame)]);
  assert.deepEqual(pending.corrected, []);

  const approved = store.put(ap, { ...draft, status: 'approved' });
  const moved = reloadFolders();
  assert.deepEqual(moved.corrected.map(row => row.key), [frameKey(ap)]);
  assert.deepEqual(moved.toReview.map(row => row.key), [frameKey(nextFrame)]);
  assert.equal(store.get(nextFrame), null);

  store.put(ap, { ...approved, status: 'draft' });
  assert.deepEqual(reloadFolders().corrected, []);
  assert.deepEqual(reloadFolders().toReview.map(row => row.key), [frameKey(ap), frameKey(nextFrame)]);
});
