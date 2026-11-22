import { frameKey } from './review.js';

const AP_VIEWS = new Set(['AP', 'DP', 'DORSOPLANTAR', 'ANTEROPOSTERIOR']);
const NON_AP_VIEWS = new Set([
  'PA', 'POSTEROANTERIOR', 'LAT', 'LATERAL', 'LL', 'RL', 'LEFTLATERAL', 'RIGHTLATERAL',
  'ML', 'LM', 'MEDIALLATERAL', 'LATERALMEDIAL', 'MEDIOLATERAL', 'LATEROMEDIAL',
  'OBL', 'OBLIQUE', 'APOBLIQUE', 'PAOBLIQUE', 'MEDIALOBLIQUE', 'LATERALOBLIQUE',
  'FRONTALOBLIQUE', 'ANTEROPOSTERIOROBLIQUE', 'POSTEROANTERIOROBLIQUE',
  'RAO', 'LAO', 'RPO', 'LPO', 'RO', 'LO', 'RIGHTOBLIQUE', 'LEFTOBLIQUE',
]);
// DICOM CID 4010 DX View. A generic frontal code still needs confirmation.
const AP_CODES = new Set(['SCT:399348003', 'SCT:399335002', 'SRT:R-10206', 'SRT:R-102C4']);
const NON_AP_CODES = new Set([
  'SCT:399160007', 'SCT:399312000', 'SCT:399038007', 'SCT:399006002', 'SCT:272479007',
  'SCT:399059000', 'SCT:399356000', 'SCT:399135007', 'SCT:30730003', 'SCT:399260004',
  'SCT:260427002', 'SCT:399352003', 'SCT:260426006', 'SCT:399198007', 'SCT:399236003',
  'SCT:399173006', 'SCT:399184004', 'SCT:399061009', 'SCT:399162004', 'SCT:399196006',
  'SCT:399004004', 'SCT:399288005', 'SCT:399225005', 'SCT:399132005', 'SCT:399325008',
  'SCT:399182000', 'SCT:399067008', 'SCT:399110001', 'SCT:399255003', 'SCT:399360002',
  'SCT:399071006', 'SCT:399272005', 'SCT:399242004', 'SCT:399351005', 'SCT:399316002',
  'SCT:399099002', 'SCT:399368009', 'SCT:119376003', 'SCT:260499007',
  'SRT:R-10204', 'SRT:R-10208', 'SRT:R-10210', 'SRT:R-10212', 'SRT:R-40888',
  'SRT:R-10216', 'SRT:R-40985', 'SRT:R-10220', 'SRT:G-A145', 'SRT:R-10224',
  'SRT:R-40783', 'SRT:R-10228', 'SRT:R-40782', 'SRT:R-10232', 'SRT:R-10234',
  'SRT:R-10236', 'SRT:R-10238', 'SRT:R-10241', 'SRT:R-10242', 'SRT:R-10244',
  'SRT:R-10246', 'SRT:R-10248', 'SRT:R-10250', 'SRT:R-10252', 'SRT:R-10254',
  'SRT:R-102C1', 'SRT:R-102CD', 'SRT:R-102C2', 'SRT:R-10256', 'SRT:R-10257',
  'SRT:R-102C3', 'SRT:R-102C5', 'SRT:R-102C6', 'SRT:R-102C7', 'SRT:R-102C8',
  'SRT:R-10230', 'SRT:R-10226', 'SRT:G-8300', 'SRT:R-40810',
]);
const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'DR', 'RG', 'OT', 'SC']);
const CALIBRATION_TYPES = new Set(['GEOMETRY', 'FIDUCIAL']);

function projectionView(instance) {
  const position = String(instance.ViewPosition ?? '').toUpperCase().replace(/[\s_-]/g, '');
  const sequence = instance.ViewCodeSequence;
  const item = Array.isArray(sequence) ? sequence[0] : sequence;
  const code = `${item?.CodingSchemeDesignator ?? ''}:${item?.CodeValue ?? ''}`;
  if (NON_AP_VIEWS.has(position) || NON_AP_CODES.has(code)) return 'non_ap';
  if (AP_VIEWS.has(position) || AP_CODES.has(code)) return 'ap';
  return 'unknown';
}
const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function spacingNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  // DICOM Decimal String allows ASCII spaces as padding, not other whitespace.
  const decimal = value.replace(/^ +| +$/g, '');
  return decimal.length <= 16 && DECIMAL_STRING.test(decimal) ? Number(decimal) : NaN;
}

export function projectionSpacing(instance) {
  const type = String(instance.PixelSpacingCalibrationType ?? '').trim().toUpperCase();
  const value = instance.PixelSpacing;
  const pair = typeof value === 'string' ? value.split('\\') : value;
  if (!CALIBRATION_TYPES.has(type) || !Array.isArray(pair) || pair.length !== 2) return null;
  const row_mm = spacingNumber(pair[0]);
  const col_mm = spacingNumber(pair[1]);
  if (![row_mm, col_mm].every(x => Number.isFinite(x) && x > 0)) return null;
  return { row_mm, col_mm, source: `DICOM Pixel Spacing (${type})` };
}

export function resolveFrame(instance, imageId, dimensions) {
  if (!instance || typeof imageId !== 'string' || !dimensions) return null;
  const [columns, rows] = dimensions;
  if (![columns, rows].every(x => Number.isSafeInteger(x) && x >= 2)) return null;
  const numberOfFrames = Number(instance.NumberOfFrames ?? 1);
  if (!Number.isSafeInteger(numberOfFrames) || numberOfFrames < 1) return null;
  const taggedFrame = instance.frameNumber;
  const locator = imageId.match(/\/frames\/(\d+)(?:[/?&#]|$)/)?.[1] ??
    imageId.match(/[?&](?:frame|frameNumber)=(\d+)(?:[&#]|$)/)?.[1];
  if (taggedFrame != null && locator != null && Number(taggedFrame) !== Number(locator)) return null;
  // The local and DICOMweb OHIF sources construct one-based frame locators.
  const frameNumber = Number(taggedFrame ?? locator ?? (numberOfFrames === 1 ? 1 : NaN));
  if (frameNumber > numberOfFrames) return null;
  const frame = {
    studyUID: instance.StudyInstanceUID,
    seriesUID: instance.SeriesInstanceUID,
    sopUID: instance.SOPInstanceUID,
    frameNumber,
    columns,
    rows,
  };
  if (!frameKey(frame)) return null;

  const modality = String(instance.Modality ?? '').trim().toUpperCase();
  return {
    ...frame,
    supportedModality: PROJECTION_MODALITIES.has(modality),
    view: projectionView(instance),
    spacing: projectionSpacing(instance),
  };
}

export function readActiveFrame(cornerstone, services) {
  const viewportId = services.viewportGridService?.getActiveViewportId();
  const viewport = viewportId && services.cornerstoneViewportService?.getCornerstoneViewport(viewportId);
  const imageId = viewport instanceof cornerstone.StackViewport ? viewport.getCurrentImageId() : null;
  // The stack index can change before the pending image has loaded.
  const data = imageId && viewport.getCornerstoneImage()?.imageId === imageId ? viewport.getImageData() : null;
  const instance = data && cornerstone.metaData.get('instance', imageId);
  const frame = resolveFrame(instance, imageId, data?.dimensions);
  if (!frame || !data.imageData?.indexToWorld || !data.imageData?.worldToIndex) return null;
  return { viewport, viewportId, imageId, frame };
}

export function canvasPoint(viewport, { x, y }) {
  const data = viewport.getImageData().imageData;
  return viewport.worldToCanvas(data.indexToWorld([x, y, 0]));
}

export function sourcePoint(viewport, frame, canvas, clamp = false) {
  const data = viewport.getImageData().imageData;
  const [x, y] = data.worldToIndex(viewport.canvasToWorld(canvas));
  if (![x, y].every(Number.isFinite)) return null;
  if (!clamp && (x < -0.5 || y < -0.5 || x > frame.columns - 0.5 || y > frame.rows - 0.5)) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(frame.columns - 1, x)),
    y: Math.max(0, Math.min(frame.rows - 1, y)),
  };
}
