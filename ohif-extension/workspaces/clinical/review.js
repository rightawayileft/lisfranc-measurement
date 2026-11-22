import { compute, isPoint, POINT_NAMES, validSpacing } from './geometry.js';

export const RELATIONS = Object.freeze(['separated', 'overlap', 'unknown']);
export const STATUSES = Object.freeze(['draft', 'approved', 'rejected', 'skipped']);
export const STORAGE_PREFIX = 'lisfranc-ohif-review/v1/';
const VIEW_SOURCES = ['dicom_ap', 'reviewer_confirmed_ap'];

export function emptyReview() {
  return { points: {}, relation: null, status: 'draft', viewSource: null, spacing: null, revision: 0, updatedAt: null };
}

function validUID(uid) {
  return typeof uid === 'string' && uid.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(uid);
}

export function frameKey(frame) {
  if (!frame) return null;
  const { studyUID, seriesUID, sopUID, frameNumber } = frame;
  if (![studyUID, seriesUID, sopUID].every(validUID)) return null;
  if (!Number.isSafeInteger(frameNumber) || frameNumber < 1) return null;
  return `${studyUID}/${seriesUID}/${sopUID}/${frameNumber}`;
}

export function canApprove(review, spacing = review.spacing) {
  const preview = compute(review.points, review.relation, spacing);
  return (
    RELATIONS.includes(review.relation) && preview.tangentStatus === 'complete' &&
    ['not_recorded', 'complete'].includes(preview.proxyStatus)
  );
}

// Each item is one projection frame. A clinical review starts with manually
// placed landmarks, so approval is the point at which it enters Corrected.
export function clinicalFolders(studyUID, targets, savedReviews) {
  const reviewsByKey = new Map();
  for (const review of savedReviews) {
    if (review.frame.studyUID === studyUID) reviewsByKey.set(frameKey(review.frame), review);
  }
  const rows = new Map();
  for (const target of targets) {
    if (target.frame.studyUID !== studyUID) continue;
    const key = frameKey(target.frame);
    if (!key || rows.has(key)) continue;
    const review = reviewsByKey.get(key) ?? null;
    if (!review && (!target.frame.supportedModality || target.frame.view === 'non_ap')) continue;
    rows.set(key, { ...target, key, review });
  }
  for (const [key, review] of reviewsByKey) {
    if (!rows.has(key)) rows.set(key, { frame: review.frame, key, review });
  }
  const folders = { toReview: [], corrected: [] };
  for (const row of rows.values()) {
    const corrected = row.review?.status === 'approved' && row.frame.view !== 'non_ap' &&
      canApprove(row.review);
    folders[corrected ? 'corrected' : 'toReview'].push(row);
  }
  return folders;
}

function normalizeSpacing(spacing) {
  if (!validSpacing(spacing)) return null;
  const { row_mm, col_mm, source } = spacing;
  return {
    row_mm,
    col_mm,
    source: typeof source === 'string' && /^[a-z0-9_(). -]{1,80}$/i.test(source) ? source : null,
  };
}

function normalizeReview(frame, review, { existing = false } = {}) {
  const { studyUID, seriesUID, sopUID, frameNumber, columns, rows } = frame;
  if (!review?.points || !STATUSES.includes(review.status) ||
    (review.relation !== null && !RELATIONS.includes(review.relation))) {
    throw new Error('Invalid Lisfranc review.');
  }

  const points = {};
  for (const name of POINT_NAMES) {
    const point = review.points[name];
    if (point == null) continue;
    if (!isPoint(point) || point.x < 0 || point.y < 0 ||
      (Number.isInteger(columns) && point.x > columns - 1) ||
      (Number.isInteger(rows) && point.y > rows - 1)) {
      throw new Error('A landmark is outside the image.');
    }
    points[name] = { x: point.x, y: point.y };
  }

  const normalized = {
    frame: { studyUID, seriesUID, sopUID, frameNumber },
    points,
    relation: review.relation,
    status: review.status,
    viewSource: VIEW_SOURCES.includes(review.viewSource) ? review.viewSource : null,
    spacing: normalizeSpacing(review.spacing),
  };
  if (normalized.status === 'approved' && !canApprove(normalized)) {
    // Version 0.1.0 allowed coincident M2 corners. Keep those saved approvals
    // readable and export their proxy as invalid until the reviewer reopens them.
    const legacy = existing && RELATIONS.includes(normalized.relation) &&
      compute(normalized.points, normalized.relation, normalized.spacing).proxyInvalidReason === 'coincident_m2_corners' &&
      canApprove({ ...normalized, points: {
        ...normalized.points, m2_proximal: null, m2_distal: null,
      } });
    if (!legacy) {
      throw new Error('Approval requires all tangent landmarks, a cortex relationship, and distinct proxy corners if started.');
    }
  }
  return normalized;
}

function readStored(storage, key, expectedFrame) {
  const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    if (frameKey(record?.frame) !== key || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new Error('Invalid record metadata.');
    }
    return {
      ...normalizeReview(expectedFrame ?? record.frame, record, { existing: true }),
      revision: record.revision,
      updatedAt: record.updatedAt,
    };
  } catch {
    throw new Error('A saved Lisfranc review is unreadable.');
  }
}

function requireKey(frame) {
  const key = frameKey(frame);
  if (!key) throw new Error('A valid DICOM image and frame is required.');
  return key;
}

function studyKeys(storage, studyUID) {
  if (!validUID(studyUID)) throw new Error('A valid DICOM study is required.');
  const prefix = `${STORAGE_PREFIX}${studyUID}/`;
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key.slice(STORAGE_PREFIX.length));
  }
  return keys.sort();
}

export function createReviewStore(storage) {
  return {
    get(frame) {
      return readStored(storage, requireKey(frame), frame);
    },

    put(frame, review) {
      const key = requireKey(frame);
      const previous = readStored(storage, key, frame);
      const revision = previous?.revision ?? 0;
      // This check detects stale snapshots. localStorage has no cross-tab transaction.
      if (review.revision !== revision) {
        throw new Error('This frame changed in another tab. Reload its saved review before editing.');
      }
      // Keep the calibration associated with the saved review, including when
      // reopening through a data source that omits or changes spacing metadata.
      const spacing = previous ? previous.spacing : review.spacing;
      const normalized = normalizeReview(frame, { ...review, spacing });
      if (previous?.status === 'approved' || previous?.status === 'rejected') {
        const sameLandmarks = JSON.stringify(previous.points) === JSON.stringify(normalized.points);
        if (normalized.status !== 'draft' || normalized.relation !== previous.relation || !sameLandmarks) {
          throw new Error('Return this review to draft before changing its landmarks or status.');
        }
      }
      const next = { ...normalized, revision: revision + 1, updatedAt: new Date().toISOString() };
      storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(next));
      return next;
    },

    // A damaged record is left intact and reported without hiding the other
    // queue items. Full exports retain their strict error behavior.
    listStudy(studyUID) {
      const reviews = [];
      let unreadable = 0;
      for (const key of studyKeys(storage, studyUID)) {
        try {
          const record = readStored(storage, key);
          if (record) reviews.push(record);
        } catch {
          unreadable++;
        }
      }
      return { reviews, unreadable };
    },

    exportStudy(studyUID) {
      return studyKeys(storage, studyUID).map(key => readStored(storage, key)).filter(Boolean);
    },
  };
}

function exportRecord(record) {
  requireKey(record.frame);
  const normalized = normalizeReview(record.frame, record, { existing: true });
  const preview = compute(normalized.points, normalized.relation, normalized.spacing);
  return {
    ...normalized,
    revision: record.revision,
    updatedAt: record.updatedAt,
    measurements: {
      tangent: {
        method_id: 'parallel_tangent_distance_v0',
        status: preview.tangentStatus,
        unsigned_px: preview.unsignedPx,
        signed_px: preview.signedPx,
        unsigned_mm: preview.unsignedMm,
        signed_mm: preview.signedMm,
      },
      proxy: {
        method_id: 'four_point_midpoint_proxy_v0',
        status: preview.proxyStatus,
        unsigned_px: preview.proxyUnsignedPx,
        unsigned_mm: preview.proxyUnsignedMm,
        m2_chord_angle_deg: preview.proxyAngleDeg,
      },
    },
  };
}

export function exportJSON(records) {
  return JSON.stringify({
    format: 'lisfranc-ohif-reviews/v1',
    coordinateSystem: 'Zero-based source image pixel centers, x right and y down',
    frameNumbering: 'One-based DICOM frame number',
    exportedAt: new Date().toISOString(),
    reviews: records.map(exportRecord),
  }, null, 2);
}

function csvCell(value) {
  if (value == null) return '';
  const cell = typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function exportCSV(records) {
  const header = [
    'study_instance_uid', 'series_instance_uid', 'sop_instance_uid', 'frame_number',
    'status', 'cortex_relation', 'revision', 'updated_at',
    'row_spacing_mm', 'column_spacing_mm', 'spacing_source',
    'tangent_method', 'tangent_status', 'tangent_unsigned_px', 'tangent_signed_px',
    'tangent_unsigned_mm', 'tangent_signed_mm',
    'proxy_method', 'proxy_status', 'proxy_unsigned_px', 'proxy_unsigned_mm', 'proxy_m2_chord_angle_deg',
    ...POINT_NAMES.flatMap(name => [`${name}_x_px`, `${name}_y_px`]),
    'view_source',
  ];
  const rows = records.map(record => {
    const { frame, points, status, relation, revision, updatedAt, spacing, measurements, viewSource } = exportRecord(record);
    const { tangent, proxy } = measurements;
    return [
      frame.studyUID, frame.seriesUID, frame.sopUID, frame.frameNumber,
      status, relation, revision, updatedAt,
      spacing?.row_mm, spacing?.col_mm, spacing?.source,
      tangent.method_id, tangent.status, tangent.unsigned_px, tangent.signed_px,
      tangent.unsigned_mm, tangent.signed_mm,
      proxy.method_id, proxy.status, proxy.unsigned_px, proxy.unsigned_mm, proxy.m2_chord_angle_deg,
      ...POINT_NAMES.flatMap(name => [points[name]?.x, points[name]?.y]),
      viewSource,
    ];
  });
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
