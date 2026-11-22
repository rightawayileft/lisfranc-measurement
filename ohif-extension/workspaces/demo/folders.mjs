const primaryLandmarks = ['c1_proximal', 'c1_distal', 'm2_tangent'];
const proxyLandmarks = ['m2_proximal', 'm2_distal'];

function samePoint(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.x === b.x && a.y === b.y;
}

function findingSignature(findings) {
  const measurements = Object.entries(findings?.measurements ?? {})
    .filter(([, measurement]) => measurement?.points.length || measurement?.direction)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, measurement]) => [
      name,
      measurement.frame_id,
      measurement.direction ?? null,
      measurement.points.map(({ x, y }) => [x, y]),
    ]);
  const fracture = findings?.avulsion;
  return JSON.stringify([
    measurements,
    fracture?.status ?? 'not_assessed',
    fracture?.status && fracture.status !== 'not_assessed' ? fracture.frame_id ?? null : null,
    fracture?.point ? [fracture.point.x, fracture.point.y] : null,
  ]);
}

export function reviewOrigin(review, proposal) {
  if (!proposal) return 'manual';
  const before = proposal.points ?? {};
  const after = review.points ?? {};
  // The advanced proxy starts hidden and is optional. Enabling an untouched
  // proposed proxy or leaving that tool off does not count as a correction.
  const landmarks = proxyLandmarks.some(name => after[name])
    ? [...primaryLandmarks, ...proxyLandmarks]
    : primaryLandmarks;
  const unchanged = review.frame_id === proposal.frame_id &&
    landmarks.every(name => samePoint(after[name], before[name])) &&
    (review.cortex_relation ?? null) === (proposal.cortex_relation ?? null) &&
    findingSignature(review.clinical_findings) === findingSignature(proposal.clinical_findings);
  return unchanged ? 'proposal_unmodified' : 'proposal_modified';
}

export function caseFolder(review, proposal) {
  if (!review || review.status === 'draft') return 'todo';
  if (review.status !== 'approved') return review.status;
  return reviewOrigin(review, proposal) === 'proposal_modified' ? 'corrected' : 'reviewed';
}
