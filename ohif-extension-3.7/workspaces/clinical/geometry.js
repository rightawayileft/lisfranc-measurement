export const POINT_NAMES = Object.freeze([
  'c1_proximal',
  'c1_distal',
  'm2_tangent',
  'm2_proximal',
  'm2_distal',
]);

export const MIN_C1_LENGTH_PX = 1;

export function isPoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

export function validSpacing(spacing) {
  return (
    Number.isFinite(spacing?.row_mm) && spacing.row_mm > 0 &&
    Number.isFinite(spacing?.col_mm) && spacing.col_mm > 0
  );
}

function scale(point, spacing) {
  return spacing
    ? [point.x * spacing.col_mm, point.y * spacing.row_mm]
    : [point.x, point.y];
}

function perpendicular(a, b, q) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return null;
  const distance = Math.abs(dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / length;
  return Number.isFinite(distance) ? distance : null;
}

function signedFromRelation(unsigned, relation) {
  if (unsigned === null) return null;
  if (relation === 'separated') return unsigned;
  if (relation === 'overlap') return -unsigned;
  return null;
}

// Port of the October 4 review geometry. Apply raster spacing to the landmarks
// before projecting, since anisotropic spacing changes the direction of the foot.
export function compute(points, relation, spacing) {
  const [a, b, q, c, d] = POINT_NAMES.map(name => {
    const point = points[name];
    return isPoint(point) ? point : null;
  });
  const metric = validSpacing(spacing) ? spacing : null;
  const preview = {
    tangentStatus: 'incomplete',
    unsignedPx: null,
    signedPx: null,
    unsignedMm: null,
    signedMm: null,
    proxyStatus: !c && !d ? 'not_recorded' : 'incomplete',
    proxyInvalidReason: null,
    proxyUnsignedPx: null,
    proxyUnsignedMm: null,
    proxyAngleDeg: null,
  };
  const degenerate = a && b && Math.hypot(b.x - a.x, b.y - a.y) < MIN_C1_LENGTH_PX;
  if (a && b && q) {
    preview.unsignedPx = degenerate ? null : perpendicular(scale(a), scale(b), scale(q));
    preview.tangentStatus = preview.unsignedPx === null ? 'invalid' : 'complete';
    preview.signedPx = signedFromRelation(preview.unsignedPx, relation);
    if (preview.tangentStatus === 'complete' && metric) {
      preview.unsignedMm = perpendicular(scale(a, metric), scale(b, metric), scale(q, metric));
      preview.signedMm = signedFromRelation(preview.unsignedMm, relation);
    }
  }
  if (a && b && c && d) {
    if (c.x === d.x && c.y === d.y) {
      preview.proxyStatus = 'invalid';
      preview.proxyInvalidReason = 'coincident_m2_corners';
      return preview;
    }
    const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    preview.proxyUnsignedPx = degenerate ? null : perpendicular(scale(a), scale(b), scale(mid));
    preview.proxyStatus = preview.proxyUnsignedPx === null ? 'invalid' : 'complete';
    if (preview.proxyStatus === 'invalid') preview.proxyInvalidReason = 'invalid_c1_line';
    if (preview.proxyStatus === 'complete') {
      const [sa, sb, sc, sd] = [a, b, c, d].map(point => scale(point, metric));
      const u = [sb[0] - sa[0], sb[1] - sa[1]];
      const v = [sd[0] - sc[0], sd[1] - sc[1]];
      const lu = Math.hypot(...u);
      const lv = Math.hypot(...v);
      if (lu > 1e-12 && lv > 1e-12) {
        const cos = Math.abs((u[0] * v[0] + u[1] * v[1]) / (lu * lv));
        if (Number.isFinite(cos)) preview.proxyAngleDeg = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
      }
      if (metric) preview.proxyUnsignedMm = perpendicular(sa, sb, scale(mid, metric));
    }
  }
  return preview;
}

export function footOfPerpendicular(a, b, q, sx = 1, sy = 1) {
  if (![a, b, q].every(isPoint) || !validSpacing({ row_mm: sy, col_mm: sx })) return null;
  const dx = (b.x - a.x) * sx;
  const dy = (b.y - a.y) * sy;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return null;
  const t = (((q.x - a.x) * sx) * dx + ((q.y - a.y) * sy) * dy) / lengthSquared;
  const foot = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return isPoint(foot) ? foot : null;
}

export function formatDistance(mm, px, signed = false) {
  if (Number.isFinite(mm)) return `${signed && mm > 0 ? '+' : ''}${mm.toFixed(2)} mm`;
  if (Number.isFinite(px)) return `${signed && px > 0 ? '+' : ''}${px.toFixed(1)} px`;
  return '-';
}
