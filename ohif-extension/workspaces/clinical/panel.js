import { createElement as h, Fragment, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { compute, formatDistance, POINT_NAMES } from './geometry.js';
import { Overlay } from './overlay.js';
import { canApprove, clinicalFolders, emptyReview, exportCSV, exportJSON, frameKey, RELATIONS } from './review.js';
import { createStudyLease, emptyClaimState } from './lease.js';
import { createSharedReviewStore, sharedStudyHref } from './shared.js';
import { readActiveFrame, resolveFrame } from './viewport.js';

const LABELS = ['C1 proximal', 'C1 distal', 'M2 tangent', 'M2 proximal', 'M2 distal'];
const STATUS = { draft: 'Draft', approved: 'Approved', rejected: 'Rejected', skipped: 'Skipped' };
const RELATION = { separated: 'Separated', overlap: 'Overlap', unknown: 'Unknown' };
const BUTTON = {
  padding: '5px 8px', border: '1px solid #527089', borderRadius: 4,
  background: '#162735', color: '#e5eef6', textAlign: 'left',
};
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 6 };
const SECTION = { display: 'grid', alignContent: 'start', gap: 9, padding: 12, fontSize: 13, color: '#e5eef6', height: '100%', overflow: 'auto' };

function button(label, onClick, { disabled, pressed, key, testId } = {}) {
  return h('button', {
    key, type: 'button', onClick, disabled, 'aria-pressed': pressed, 'data-testid': testId,
    style: { ...BUTTON, background: pressed ? '#245777' : BUTTON.background, opacity: disabled ? 0.48 : 1 },
  }, label);
}

function sameTarget(a, b) {
  return a?.viewport === b?.viewport && a?.viewportId === b?.viewportId &&
    a?.imageId === b?.imageId && frameKey(a?.frame) === frameKey(b?.frame);
}

function sameFrameState(a, b) {
  return sameTarget(a, b) && a?.frame.view === b?.frame.view &&
    a?.frame.supportedModality === b?.frame.supportedModality &&
    a?.frame.rows === b?.frame.rows && a?.frame.columns === b?.frame.columns &&
    a?.frame.spacing?.row_mm === b?.frame.spacing?.row_mm &&
    a?.frame.spacing?.col_mm === b?.frame.spacing?.col_mm &&
    a?.frame.spacing?.source === b?.frame.spacing?.source;
}

function useActiveFrame(cornerstone, services) {
  const [active, setActive] = useState(null);
  useEffect(() => {
    if (!cornerstone) return;
    const { viewportGridService: grid, cornerstoneViewportService: viewportService } = services;
    const events = cornerstone.Enums.Events;
    const target = cornerstone.eventTarget;
    let lastElement;
    let queued = 0;
    const renderEvents = [
      events.IMAGE_RENDERED, events.STACK_NEW_IMAGE, events.PRE_STACK_NEW_IMAGE, events.IMAGE_SPACING_CALIBRATED,
    ];
    const globalEvents = [events.ELEMENT_ENABLED, events.ELEMENT_DISABLED, events.IMAGE_LOAD_ERROR];
    const schedule = () => {
      if (!queued) queued = requestAnimationFrame(sync);
    };
    const detach = () => renderEvents.forEach(event => lastElement?.removeEventListener(event, schedule));
    function sync() {
      queued = 0;
      const id = grid.getActiveViewportId();
      const element = id && viewportService.getCornerstoneViewport(id)?.element;
      if (element !== lastElement) {
        detach();
        lastElement = element;
        renderEvents.forEach(event => element?.addEventListener(event, schedule));
      }
      const next = readActiveFrame(cornerstone, services);
      setActive(previous => sameFrameState(previous, next) ? previous : next);
    }
    const subscriptions = [
      grid.subscribe(grid.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED, schedule),
      grid.subscribe(grid.EVENTS.GRID_STATE_CHANGED, schedule),
      grid.subscribe(grid.EVENTS.VIEWPORTS_READY, schedule),
      viewportService.subscribe(viewportService.EVENTS.VIEWPORT_DATA_CHANGED, schedule),
    ];
    globalEvents.forEach(event => target.addEventListener(event, schedule));
    schedule();
    return () => {
      cancelAnimationFrame(queued);
      subscriptions.forEach(({ unsubscribe }) => unsubscribe());
      globalEvents.forEach(event => target.removeEventListener(event, schedule));
      detach();
    };
  }, [cornerstone, services]);
  return active;
}

function download(contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type: type === 'json' ? 'application/json' : 'text/csv' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lisfranc-reviews.${type}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable';
}

function FrameHistory({ frame, store, revision }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState({ items: null, error: null });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setHistory({ items: null, error: null });
    store.history(frame, controller.signal).then(items => {
      if (!controller.signal.aborted) setHistory({ items, error: null });
    }, error => {
      if (!controller.signal.aborted) setHistory({ items: null, error });
    });
    return () => controller.abort();
  }, [open, store, revision, frame.studyUID, frame.seriesUID, frame.sopUID, frame.frameNumber]);

  return h('div', null, button(open ? 'Close history' : 'History', () => setOpen(!open), { pressed: open }),
    open && h('section', {
      'aria-label': 'Frame review history', 'data-testid': 'lisfranc-frame-history',
      style: { maxHeight: 180, overflowY: 'auto', overflowWrap: 'anywhere', paddingBlock: 4 },
    }, history.error ? h('p', { role: 'alert' }, history.error.message) :
      !history.items ? h('p', { role: 'status' }, 'Loading history.') :
      !history.items.length ? h('p', null, 'No saved revisions for this frame.') :
      h('ul', null, history.items.map(record => {
        const values = compute(record.points, record.relation, record.spacing);
        const tangent = formatDistance(values.signedMm ?? values.unsignedMm, values.signedPx ?? values.unsignedPx,
          values.signedPx !== null);
        return h('li', { key: record.revision },
          `Revision ${record.revision} � ${STATUS[record.status]} � ${record.updatedBy || 'Unknown reviewer'}`,
          h('div', null, `${formatTime(record.updatedAt)} � Tangent ${tangent}`));
      }))),
  );
}

function StudyClaimStatus({ lease, state, busy }) {
  const status = state.held ? 'You are editing this study' :
    state.retryClaim ? 'Study claim could not be confirmed' :
    state.claim ? `Claimed by ${state.claim.holder}` : 'Study available';
  return h('div', { 'data-testid': 'lisfranc-study-claim', style: { overflowWrap: 'anywhere' } },
    h('div', { role: 'status' },
      state.busy ? 'Checking study claim.' : status,
      !state.busy && state.claim && h('small', null, ` � Expires ${formatTime(state.claim.expiresAt)}`)),
    state.error && h('p', { role: 'alert' }, state.error.message),
    (state.held || state.retryClaim) && button('Release study', () => lease.release(), { disabled: busy || state.busy }),
  );
}

function FrameReview({ active, cornerstone, services, store, onSaved, lease, leaseState }) {
  const { frame } = active;
  const frameIdentity = frameKey(frame);
  const activeRequest = useRef(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const saved = useRef(null);
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(POINT_NAMES[0]);
  const [confirmed, setConfirmed] = useState(false);
  const isCurrent = () => sameFrameState(active, readActiveFrame(cornerstone, services));
  const remember = next => { saved.current = next; setReview(next); };

  async function reload() {
    if (writing.current) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setEditing(false);
    setConfirmed(false);
    try {
      const next = await store.get(frame, controller.signal);
      if (controller.signal.aborted) return;
      remember(next ?? emptyReview());
      setPending(null);
      setError(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (frame.supportedModality) void reload();
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
    };
  }, [frameIdentity, frame.supportedModality, store]);
  useEffect(() => {
    lease?.setEditing(editing);
    return () => lease?.setEditing(false);
  }, [lease, editing]);

  async function write(nextReview, onSuccess) {
    if (writing.current || loading || !saved.current || !lease || !isCurrent()) return;
    writing.current = true;
    setBusy(true);
    try {
      const next = await lease.run(leaseId => {
        if (!isCurrent()) return null;
        return store.put(frame, nextReview, leaseId);
      });
      if (!next) return;
      onSaved();
      if (next.status !== 'draft') void lease.release();
      if (!mounted.current) return;
      remember(next);
      onSuccess?.();
      setPending(null);
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure.code === 'study_claimed') void lease.observe().catch(() => {});
      else setPending({ nextReview, onSuccess });
      setError(failure);
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function update(change, onSuccess) {
    if (!saved.current || pending) return;
    void write({
      ...saved.current,
      spacing,
      viewSource: viewSource ?? saved.current.viewSource,
      ...change,
    }, onSuccess);
  }

  function savePoint(name, point) {
    if (!saved.current || !editable) return;
    const points = { ...saved.current.points, [name]: point };
    const next = POINT_NAMES.find(item => !points[item]);
    update({ points, status: 'draft' }, () => setSelected(next ?? name));
  }

  function setStatus(status) {
    update({ status }, () => setEditing(false));
  }

  async function toggleEditing() {
    if (editing && leaseState.held) {
      setEditing(false);
      return;
    }
    if (!editable || !lease) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      await lease.acquire();
      if (controller.signal.aborted || !isCurrent()) return;
      const latest = await store.get(frame, controller.signal) ?? emptyReview();
      if (controller.signal.aborted || !isCurrent()) return;
      remember(latest);
      setError(null);
      if (latest.status === 'approved' || latest.status === 'rejected') void lease.release();
      else setEditing(true);
    } catch (failure) {
      if (failure.code === 'study_claimed') void lease.observe().catch(() => {});
      if (!controller.signal.aborted && lease.current().error !== failure) setError(failure);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function exportReviews(type) {
    if (!isCurrent()) return;
    try {
      const rows = await store.listStudy(frame.studyUID);
      if (mounted.current && isCurrent()) download(type === 'json' ? exportJSON(rows) : exportCSV(rows), type);
    } catch (failure) {
      if (mounted.current) setError(failure);
    }
  }

  const header = h('div', { 'data-testid': 'lisfranc-frame' }, `Frame ${frame.frameNumber}`);
  const retryable = pending && (error?.status === 0 || error?.status >= 500 || error?.code === 'claim_required');
  const errorRow = error && h('div', { role: 'alert' }, error.message, ' ',
    retryable && button('Retry save', () => write(pending.nextReview, pending.onSuccess), { disabled: busy || loading }),
    button('Reload saved review', reload, { disabled: busy || loading }));
  if (!frame.supportedModality) return h('p', null, 'Select a projection image in a stack viewport.');
  if (!review) return h('div', null, header, loading && h('p', { role: 'status' }, 'Loading shared review.'), errorRow);

  const manuallyConfirmed = review.viewSource === 'reviewer_confirmed_ap';
  const viewSource = frame.view === 'ap' ? 'dicom_ap' :
    frame.view === 'unknown' && (confirmed || manuallyConfirmed) ? 'reviewer_confirmed_ap' : null;
  const viewReady = viewSource !== null;
  const locked = review.status === 'approved' || review.status === 'rejected';
  const occupied = leaseState.claim && !leaseState.held && !leaseState.retryClaim;
  const controlsLocked = busy || loading || Boolean(pending) || occupied || leaseState.busy ||
    !lease || [401, 403, 404].includes(error?.status);
  const editable = viewReady && !locked && !controlsLocked;
  const toolEditing = editing && leaseState.held;
  const spacing = review.revision ? review.spacing : frame.spacing;
  const values = compute(review.points, review.relation, spacing);
  const signed = values.signedPx !== null;
  const tangent = formatDistance(signed ? values.signedMm : values.unsignedMm,
    signed ? values.signedPx : values.unsignedPx, signed);
  const proxy = formatDistance(values.proxyUnsignedMm, values.proxyUnsignedPx);
  const proxyAngle = values.proxyAngleDeg === null ? '' : `, ${values.proxyAngleDeg.toFixed(1)}� chord angle`;

  return h(Fragment, null,
    header,
    lease && h(StudyClaimStatus, { lease, state: leaseState, busy }),
    frame.view === 'non_ap' && h('p', { role: 'status' }, 'Select an AP/DP view to measure the C1-M2 interval.'),
    frame.view === 'unknown' && (manuallyConfirmed ? h('div', null, 'AP/DP confirmed manually') : h('label', null,
      h('input', { type: 'checkbox', checked: confirmed, disabled: controlsLocked || locked, onChange: event => {
        setConfirmed(event.target.checked);
        setEditing(false);
      } }), ' Confirm AP/DP view')),
    h('div', null, spacing?.source ?? 'Pixel distances only'),
    h('div', { 'data-testid': 'lisfranc-status', role: 'status' },
      busy ? 'Saving to shared queue.' : loading ? 'Loading shared review.' :
      pending ? 'Change not confirmed' : review.revision ? `${STATUS[review.status]} � saved to shared queue` : 'Not started'),
    errorRow,
    h('div', { style: ROW }, button(toolEditing ? 'Finish editing' : 'Edit landmarks', toggleEditing, { disabled: !editable, pressed: toolEditing })),
    toolEditing && editable && h('div', { style: { display: 'grid', gap: 6 } },
      h('p', null, 'Choose a landmark, then click the image. Drag an existing point to correct it.'),
      h('div', { style: ROW }, POINT_NAMES.map((name, i) => button(LABELS[i], () => setSelected(name), { key: name, pressed: selected === name }))),
      button('Remove selected landmark', () => {
        const points = { ...saved.current.points };
        delete points[selected];
        update({ points, status: 'draft' });
      }, { disabled: !review.points[selected] })),
    h('label', null, 'Cortex relation ',
      h('select', { 'aria-label': 'Cortex relation', value: review.relation ?? '', disabled: !editable, style: BUTTON,
        onChange: event => update({ relation: event.target.value || null, status: 'draft' }) },
      h('option', { value: '' }, 'Select'), ...RELATIONS.map(value => h('option', { key: value, value }, RELATION[value])))),
    h('div', { 'data-testid': 'lisfranc-tangent' }, `Parallel tangent: ${values.tangentStatus === 'invalid' ? 'Invalid C1 line' : tangent}`),
    h('div', { 'data-testid': 'lisfranc-proxy' }, `Midpoint proxy: ${values.proxyStatus === 'invalid'
      ? values.proxyInvalidReason === 'coincident_m2_corners' ? 'Place distinct M2 corners' : 'Invalid C1 line'
      : proxy + proxyAngle}`),
    h('div', { style: ROW }, locked ? button('Reopen', () => setStatus('draft'), { disabled: controlsLocked }) : [
      button('Approve', () => setStatus('approved'), { key: 'approve', disabled: !editable || !canApprove(review, spacing) }),
      button('Skip', () => setStatus('skipped'), { key: 'skip', disabled: controlsLocked || review.status === 'skipped' }),
      button('Reject', () => setStatus('rejected'), { key: 'reject', disabled: !editable }),
    ]),
    h('div', { style: ROW },
      button('Export JSON', () => exportReviews('json'), { disabled: busy || loading || Boolean(pending) }),
      button('Export CSV', () => exportReviews('csv'), { disabled: busy || loading || Boolean(pending) }),
      !error && button('Reload saved review', reload, { disabled: busy || loading })),
    h(FrameHistory, { frame, store, revision: review.revision }),
    viewReady && h(Overlay, {
      active, events: cornerstone.Enums.Events, points: review.points, relation: review.relation, spacing,
      selected, editing: toolEditing && editable, select: setSelected, save: savePoint, isCurrent,
    }),
  );
}

function clinicalTargets(cornerstone, active) {
  const { frame, imageId, viewport } = active;
  const targets = [];
  viewport.getImageIds().forEach((id, stackIndex) => {
    if (id === imageId) {
      targets.push({ frame, imageId: id, stackIndex });
      return;
    }
    const instance = cornerstone.metaData.get('instance', id);
    if (!instance) return;
    const target = resolveFrame(instance, id, [Number(instance.Columns), Number(instance.Rows)]);
    if (target) targets.push({ frame: target, imageId: id, stackIndex });
  });
  return targets;
}

function useSharedList(store, studyUID, revision) {
  const [state, setState] = useState({ items: null, error: null, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true }));
    const load = studyUID === undefined ? store.listStudies(controller.signal) : store.listStudy(studyUID, controller.signal);
    load.then(items => {
      if (!controller.signal.aborted) setState({ items, error: null, loading: false });
    }, error => {
      if (!controller.signal.aborted) setState({ items: null, error, loading: false });
    });
    return () => controller.abort();
  }, [store, studyUID, revision]);
  return state;
}

function ClinicalQueue({ active, cornerstone, services, store, revision, folder, setFolder }) {
  const [navigationError, setNavigationError] = useState('');
  const studyUID = active.frame.studyUID;
  const { items, error, loading } = useSharedList(store, studyUID, revision);
  const folders = useMemo(() => items && clinicalFolders(studyUID, clinicalTargets(cornerstone, active), items),
    [studyUID, cornerstone, active, items]);

  function selectFrame(row) {
    if (!row.imageId || row.imageId === active.imageId) return;
    const current = readActiveFrame(cornerstone, services);
    if (!sameTarget(current, active)) return;
    const index = active.viewport.getImageIds().indexOf(row.imageId);
    if (index < 0) return;
    setNavigationError('');
    active.viewport.setImageIdIndex(index).catch(() =>
      setNavigationError('Could not open that frame. Select it in the OHIF viewport to retry.'));
  }

  const currentKey = frameKey(active.frame);
  return h('section', {
    'aria-label': 'Clinical study folders', 'data-testid': 'lisfranc-clinical-queue',
    style: { display: 'grid', gap: 6 },
  },
  h('h3', { style: { fontSize: 13, fontWeight: 600 } }, 'Clinical study folders'),
  error ? h('p', { role: 'alert' }, error.message) : !folders ?
    h('p', { role: 'status' }, loading ? 'Loading study folders.' : 'Study folders unavailable.') : h(Fragment, null,
    h('div', { style: ROW },
      button(`To review (${folders.toReview.length})`, () => setFolder('toReview'), {
        pressed: folder === 'toReview', testId: 'lisfranc-clinical-folder-to-review',
      }),
      button(`Corrected (${folders.corrected.length})`, () => setFolder('corrected'), {
        pressed: folder === 'corrected', testId: 'lisfranc-clinical-folder-corrected',
      })),
    folders[folder].length
      ? h('ul', { style: { display: 'grid', gap: 3, maxHeight: 104, overflowY: 'auto' } },
        folders[folder].map((row, ordinal) => {
          const status = row.review ? STATUS[row.review.status] : 'Not started';
          const image = row.imageId ? `Image ${row.stackIndex + 1}` : `Saved image ${ordinal + 1}`;
          const label = `${image} � Frame ${row.frame.frameNumber} � ${status}`;
          const current = row.key === currentKey;
          return h('li', { key: row.key },
            row.imageId
              ? h('button', {
                type: 'button', 'aria-current': current ? 'true' : undefined,
                'data-testid': 'lisfranc-clinical-case', style: BUTTON, onClick: () => selectFrame(row),
              }, label)
              : h('span', null, `${label} � Load its series to open`));
        }))
      : h('p', null, folder === 'corrected' ? 'No approved corrections in this study.' : 'No frames in this folder.'),
    navigationError && h('p', { role: 'alert' }, navigationError),
  ));
}

function SharedCorrected({ store, revision, refresh, currentStudy }) {
  const { items, error, loading } = useSharedList(store, undefined, revision);
  const correctedStudies = (items ?? []).filter(study => study.correctedCount > 0);
  const count = correctedStudies.reduce((total, study) => total + study.correctedCount, 0);
  const viewerPath = window.config?.lisfrancClinicalStudyPath;
  return h('section', { 'aria-label': 'Shared Corrected', 'data-testid': 'lisfranc-shared-corrected' },
    h('details', null,
      h('summary', null, items ? `Shared Corrected (${count})` : 'Shared Corrected'),
      error ? h('p', { role: 'alert' }, error.message) :
        !items ? h('p', { role: 'status' }, 'Loading shared studies.') :
        correctedStudies.length === 0 ? h('p', null, 'No corrections have been approved.') :
        h(Fragment, null,
          h('p', null, 'Open a study in OHIF to review its corrected frames.'),
          h('ul', { style: { overflowWrap: 'anywhere', maxHeight: 150, overflowY: 'auto' } },
            correctedStudies.map(study => {
              const isCurrent = study.studyUID === currentStudy;
              const href = isCurrent ? null : sharedStudyHref(study.studyUID, viewerPath);
              const label = `Study ${study.studyUID} � ${study.correctedCount} corrected${isCurrent ? ' � open' : ''}`;
              return h('li', { key: study.studyUID, 'aria-current': isCurrent || undefined },
                href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : label);
            }))),
      ),
    button('Refresh shared queue', refresh, { disabled: loading }),
    !items && error && h('small', { role: 'status' }, 'Shared Clinical queue unavailable.'),
    error?.status === 401 && h('div', null, h('a', {
      href: '/api/lisfranc-clinical/v1/sign-in', target: '_blank', rel: 'noopener', style: { color: '#a9d7ff' },
    }, 'Sign in to Clinical')),
  );
}

function useStudyClaim(store, currentStudy, paused, revision) {
  const [scope, setScope] = useState(currentStudy);
  // A transient missing frame while loading the next image should not release
  // the claim for that study. Switch scope after the new study is identified.
  useEffect(() => {
    if (currentStudy) setScope(currentStudy);
  }, [currentStudy]);
  const lease = useMemo(() => scope ? createStudyLease(store, scope) : null, [store, scope]);
  const [snapshot, setSnapshot] = useState({ lease: null, state: emptyClaimState });
  useEffect(() => {
    if (!lease) return;
    const update = state => setSnapshot({ lease, state });
    update(lease.current());
    const unsubscribe = lease.subscribe(update);
    const releaseOnPageHide = () => { void lease.release({ keepalive: true }); };
    window.addEventListener('pagehide', releaseOnPageHide);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', releaseOnPageHide);
      releaseOnPageHide();
    };
  }, [lease]);
  useEffect(() => {
    if (!lease) return;
    if (paused) {
      void lease.release();
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && lease.current().held && lease.isEditing()) {
        void lease.acquire(true).catch(() => {});
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [lease, paused]);
  useEffect(() => {
    if (!lease || paused) return;
    const controller = new AbortController();
    void lease.observe(controller.signal);
    return () => controller.abort();
  }, [lease, paused, revision]);
  return lease?.studyUID === currentStudy && !paused
    ? { lease, leaseState: snapshot.lease === lease ? snapshot.state : emptyClaimState }
    : { lease: null, leaseState: emptyClaimState };
}

export function LisfrancPanel({ cornerstone, services, paused = false }) {
  const active = useActiveFrame(cornerstone, services);
  const store = useMemo(() => createSharedReviewStore(), []);
  const [revision, refreshQueue] = useReducer(value => value + 1, 0);
  const [selection, setSelection] = useState(null);
  useEffect(() => {
    if (paused) return;
    function refreshIfVisible() {
      if (document.visibilityState === 'visible') refreshQueue();
    }
    refreshIfVisible();
    const timer = window.setInterval(refreshIfVisible, 20_000);
    window.addEventListener('focus', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
    };
  }, [paused]);
  const studyUID = active?.frame.studyUID;
  const { lease, leaseState } = useStudyClaim(store, studyUID, paused, revision);
  const folder = selection && selection.studyUID === studyUID ? selection.folder : 'toReview';
  return h('section', { style: SECTION, 'aria-label': 'Lisfranc interval review' },
    h('h2', { style: { fontSize: 16, fontWeight: 600 } }, 'C1-M2 interval'),
    h(SharedCorrected, { store, revision, refresh: refreshQueue, currentStudy: studyUID }),
    active ? h(Fragment, null,
      active.frame.supportedModality && h(ClinicalQueue, {
        key: studyUID, active, cornerstone, services, store, revision, folder,
        setFolder: next => setSelection({ studyUID, folder: next }),
      }),
      h(FrameReview, {
        key: `${active.viewportId}:${frameKey(active.frame)}`, active, cornerstone, services, store,
        onSaved: refreshQueue, lease, leaseState,
      }),
    ) : h('p', null, 'Select a loaded DICOM projection image in the active stack.'),
  );
}
