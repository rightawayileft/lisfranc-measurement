import { frameKey } from './review.js';

const API_ROOT = '/api/lisfranc-clinical/v1';
const UID = /^[0-9]+(?:\.[0-9]+)*$/;

function validUID(uid) {
  return typeof uid === 'string' && uid.length <= 64 && UID.test(uid);
}

export function sharedStudyHref(studyUID, path) {
  if (!validUID(studyUID) || typeof path !== 'string' ||
      !/^\/[a-z0-9_-][a-z0-9_/-]*$/i.test(path) || path.includes('//')) return null;
  return `${path}?StudyInstanceUIDs=${studyUID}`;
}

const messages = {
  401: 'Sign in with your Clinical reviewer account.',
  403: 'Your account cannot access this review.',
  404: 'This study is not enrolled for shared Clinical review, or the service is unavailable.',
  409: 'Another reviewer changed this frame. Reload the saved review before placing your edit again.',
  422: 'The server could not save that review. Check the frame and landmarks.',
};

export class SharedReviewError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function studyPath(studyUID) {
  if (!validUID(studyUID)) {
    throw new Error('A valid DICOM study UID is required.');
  }
  return `/studies/${studyUID}`;
}

function framePath(frame) {
  if (!frameKey(frame)) throw new Error('A valid DICOM image and frame is required.');
  const { studyUID, seriesUID, sopUID, frameNumber } = frame;
  return `${studyPath(studyUID)}/frames/${seriesUID}/${sopUID}/${frameNumber}`;
}

function readReview(data, frame, optional) {
  const record = data?.review;
  if (record === null && optional) return null;
  if (frameKey(record?.frame) !== frameKey(frame) || !Number.isSafeInteger(record?.revision) || record.revision < 1 ||
      !record.points || !['draft', 'approved', 'rejected', 'skipped'].includes(record.status)) {
    throw new SharedReviewError(0, 'The hospital service returned an invalid frame review.');
  }
  return record;
}

function readClaim(data) {
  const claim = data?.claim;
  if (claim === null) return null;
  if (typeof claim?.holder !== 'string' || !claim.holder || !Number.isFinite(Date.parse(claim.expiresAt))) {
    throw new SharedReviewError(0, 'The hospital service returned an invalid study claim.');
  }
  return claim;
}

export function createSharedReviewStore(fetchRequest = globalThis.fetch.bind(globalThis)) {
  async function request(path, { body, signal, method = 'GET', leaseId, keepalive = false } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, 15_000);
    const headers = { Accept: 'application/json' };
    const options = {
      credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
      redirect: 'error', headers, signal: controller.signal, method, keepalive,
    };
    if (leaseId) headers['X-Lisfranc-Lease'] = leaseId;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetchRequest(API_ROOT + path, options);
      if (!response.ok) {
        const problem = response.status === 409 && await response.json().catch(() => null);
        if (problem?.code === 'claim_required') {
          throw new SharedReviewError(409, 'Your study claim ended. Claim it again before saving.', 'claim_required');
        }
        if (response.status === 409 && path.endsWith('/claim')) {
          throw new SharedReviewError(409, 'Another reviewer has claimed this study.', 'study_claimed');
        }
        throw new SharedReviewError(response.status, messages[response.status] ?? 'The hospital review service is unavailable.');
      }
      return await response.json();
    } catch (failure) {
      if (signal?.aborted || failure instanceof SharedReviewError) throw failure;
      if (controller.signal.aborted) throw new SharedReviewError(0, 'The hospital review service timed out.');
      const message = failure instanceof SyntaxError ? 'The hospital service returned an invalid response.' :
        'Could not reach the hospital review service.';
      throw new SharedReviewError(0, message);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return {
    async get(frame, signal) {
      return readReview(await request(framePath(frame), { signal }), frame, true);
    },
    async put(frame, review, leaseId, signal) {
      if (!leaseId) throw new SharedReviewError(409, 'Claim this study before saving.', 'claim_required');
      const { revision, points, relation, status, viewSource, spacing } = review;
      const body = {
        baseRevision: revision,
        frame: {
          studyUID: frame.studyUID, seriesUID: frame.seriesUID, sopUID: frame.sopUID,
          frameNumber: frame.frameNumber, rows: frame.rows, columns: frame.columns,
          view: frame.view, supportedModality: frame.supportedModality, spacing: frame.spacing,
        },
        points, relation, status, viewSource, spacing,
      };
      return readReview(await request(framePath(frame), { method: 'PUT', body, leaseId, signal }), frame, false);
    },
    async getClaim(studyUID, signal) {
      return readClaim(await request(studyPath(studyUID) + '/claim', { signal }));
    },
    async claim(studyUID, leaseId) {
      const claim = readClaim(await request(studyPath(studyUID) + '/claim', { method: 'PUT', body: { leaseId } }));
      if (!claim) throw new SharedReviewError(0, 'The hospital service did not confirm the study claim.');
      return claim;
    },
    async release(studyUID, leaseId, { keepalive = false } = {}) {
      return readClaim(await request(studyPath(studyUID) + '/claim', { method: 'DELETE', leaseId, keepalive }));
    },
    async history(frame, signal) {
      const data = await request(framePath(frame) + '/history', { signal });
      if (!Array.isArray(data?.history)) throw new SharedReviewError(0, 'The hospital service returned an invalid review history.');
      return data.history.map(review => readReview({ review }, frame, false));
    },
    async listStudy(studyUID, signal) {
      const data = await request(studyPath(studyUID) + '/reviews', { signal });
      if (!Array.isArray(data?.reviews) || data.reviews.some(record =>
        record?.frame?.studyUID !== studyUID || !frameKey(record.frame) || !Number.isSafeInteger(record.revision) ||
        record.revision < 1 || !record.points || !['draft', 'approved', 'rejected', 'skipped'].includes(record.status))) {
        throw new SharedReviewError(0, 'The hospital service returned an invalid study queue.');
      }
      return data.reviews;
    },
    async listStudies(signal) {
      const data = await request('/studies', { signal });
      if (!Array.isArray(data?.studies) || data.studies.some(study =>
        !validUID(study?.studyUID) ||
        !Number.isSafeInteger(study.correctedCount) || study.correctedCount < 0 ||
        !Number.isSafeInteger(study.reviewCount) || study.reviewCount < study.correctedCount)) {
        throw new SharedReviewError(0, 'The hospital service returned an invalid shared queue.');
      }
      return data.studies;
    },
  };
}
