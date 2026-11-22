import assert from 'node:assert/strict';
import test from 'node:test';
import { caseFolder, reviewOrigin } from './folders.mjs';

const proposal = {
  frame_id: 1001,
  points: {
    c1_proximal: { x: 75, y: 90 },
    c1_distal: { x: 88, y: 95 },
    m2_tangent: { x: 81, y: 100 },
    m2_proximal: { x: 79, y: 104 },
    m2_distal: { x: 86, y: 106 },
  },
  cortex_relation: 'separated',
  clinical_findings: {
    schema_version: 1,
    measurements: { soft_tissue: { frame_id: 1002, points: [{ x: 85, y: 90 }, { x: 79, y: 86 }] } },
    avulsion: { frame_id: 1001, status: 'absent', point: null },
    note: 'Model draft.',
  },
};

test('a saved correction moves from To review to Corrected on approval and back on reopen', () => {
  const review = structuredClone(proposal);
  review.clinical_findings.measurements.soft_tissue.points[1].x -= 1;
  assert.equal(caseFolder(undefined, proposal), 'todo');
  assert.equal(caseFolder({ ...review, status: 'draft' }, proposal), 'todo');
  assert.equal(caseFolder({ ...review, status: 'approved' }, proposal), 'corrected');
  assert.equal(caseFolder({ ...review, status: 'draft' }, proposal), 'todo');
  assert.equal(caseFolder({ ...review, status: 'rejected' }, proposal), 'rejected');
});

test('approving an unchanged proposal, keeping the proxy hidden, and editing a note remain Reviewed', () => {
  const review = structuredClone(proposal);
  review.status = 'approved';
  review.clinical_findings.note = 'Reviewed at the workstation.';
  delete review.points.m2_proximal;
  delete review.points.m2_distal;
  assert.equal(reviewOrigin(review, proposal), 'proposal_unmodified');
  assert.equal(caseFolder(review, proposal), 'reviewed');
  assert.equal(caseFolder(review), 'reviewed');
});

test('changes to landmarks, cortex relation, or fragment status move approvals to Corrected', () => {
  for (const change of [
    review => { review.points.c1_distal.x += 0.25; },
    review => { review.points.m2_distal.y += 1; },
    review => { review.cortex_relation = 'overlap'; },
    review => { review.clinical_findings.avulsion.status = 'uncertain'; },
    review => { delete review.clinical_findings.measurements.soft_tissue; },
  ]) {
    const review = { ...structuredClone(proposal), status: 'approved' };
    change(review);
    assert.equal(caseFolder(review, proposal), 'corrected');
  }
});
