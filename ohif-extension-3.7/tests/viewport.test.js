import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasPoint, projectionSpacing, readActiveFrame, resolveFrame, sourcePoint } from '../workspaces/clinical/viewport.js';

const instance = {
  StudyInstanceUID: '2.25.70001', SeriesInstanceUID: '2.25.70002', SOPInstanceUID: '2.25.70003',
  Modality: 'DX', ViewPosition: 'DP',
};

test('projection distance requires a declared positive anisotropic calibration', () => {
  assert.deepEqual(projectionSpacing({ PixelSpacing: [0.5, 0.25], PixelSpacingCalibrationType: 'GEOMETRY' }),
    { row_mm: 0.5, col_mm: 0.25, source: 'DICOM Pixel Spacing (GEOMETRY)' });
  assert.equal(projectionSpacing({ PixelSpacing: [0.5, 0.25] }), null);
  assert.equal(projectionSpacing({ ImagerPixelSpacing: [0.5, 0.25], PixelSpacingCalibrationType: 'FIDUCIAL' }), null);
  assert.equal(projectionSpacing({ PixelSpacing: [0.5, 0], PixelSpacingCalibrationType: 'FIDUCIAL' }), null);
});

test('PixelSpacing accepts decimal strings and rejects coerced non-decimal values', () => {
  const calibration = { PixelSpacingCalibrationType: 'GEOMETRY' };
  for (const value of [[' +.5 ', '2.5e-1'], ' +.5 \\2.5e-1']) {
    assert.deepEqual(projectionSpacing({ ...calibration, PixelSpacing: value }),
      { row_mm: 0.5, col_mm: 0.25, source: 'DICOM Pixel Spacing (GEOMETRY)' });
  }
  for (const invalid of [true, ['0.5'], '0x1', '0b1', '0. 5', '\t0.5', '0.5\n', '1e999']) {
    assert.equal(projectionSpacing({ ...calibration, PixelSpacing: [invalid, 0.25] }),
      null, `Expected pixel-only fallback for ${JSON.stringify(invalid)}`);
  }
});

test('frame identity follows the displayed instance and one-based WADO-RS frame locator', () => {
  const frame = resolveFrame(instance, 'dicomfile:0', [120, 80]);
  assert.deepEqual(frame, {
    studyUID: '2.25.70001', seriesUID: '2.25.70002', sopUID: '2.25.70003', frameNumber: 1,
    columns: 120, rows: 80, spacing: null, supportedModality: true, view: 'ap',
  });
  const multi = { ...instance, NumberOfFrames: 3 };
  assert.equal(resolveFrame(multi, 'wadors:synthetic/frames/2', [120, 80]).frameNumber, 2);
  assert.equal(resolveFrame(multi, 'wadors:synthetic/frames/3', [120, 80]).frameNumber, 3);
  assert.equal(resolveFrame(multi, 'dicomfile:0', [120, 80]), null);
  assert.equal(resolveFrame(multi, 'wadors:synthetic/frames/0', [120, 80]), null);
  assert.equal(resolveFrame(multi, 'wadors:synthetic/frames/4', [120, 80]), null);
  assert.equal(resolveFrame({ ...multi, frameNumber: 1 }, 'wadors:synthetic/frames/2', [120, 80]), null);
});

test('explicit non-AP projection metadata prevents AP confirmation', () => {
  const view = tags => resolveFrame({ ...instance, ...tags }, 'dicomfile:0', [120, 80]).view;
  assert.equal(view({ ViewPosition: 'LAT' }), 'non_ap');
  assert.equal(view({ ViewPosition: 'AP Oblique' }), 'non_ap');
  assert.equal(view({ ViewPosition: '' }), 'unknown');
  assert.equal(view({ ViewPosition: '', ViewCodeSequence: [{ CodingSchemeDesignator: 'SCT', CodeValue: '399348003' }] }), 'ap');
  assert.equal(view({ ViewPosition: '', ViewCodeSequence: [{ CodingSchemeDesignator: 'SRT', CodeValue: 'R-102C4' }] }), 'ap');
  assert.equal(view({ ViewPosition: '', ViewCodeSequence: [{ CodingSchemeDesignator: 'SCT', CodeValue: '399067008' }] }), 'non_ap');
  assert.equal(view({ ViewPosition: '', ViewCodeSequence: [{ CodingSchemeDesignator: 'SRT', CodeValue: 'R-102C1' }] }), 'non_ap');
  assert.equal(view({ ViewCodeSequence: [{ CodingSchemeDesignator: 'SCT', CodeValue: '399352003' }] }), 'non_ap');
  assert.equal(view({ ViewPosition: '', ViewCodeSequence: [{ CodingSchemeDesignator: 'LOCAL', CodeValue: '399348003' }] }), 'unknown');
});

class SyntheticStack {
  currentImage = 'dicomfile:0';
  requestedImage = 'dicomfile:0';
  getCurrentImageId() { return this.requestedImage; }
  getCornerstoneImage() { return { imageId: this.currentImage }; }
  getImageData() {
    return {
      dimensions: [120, 80],
      imageData: {
        indexToWorld: ([x, y, z]) => [x * 0.25 + 20, y * 0.5 - 10, z],
        worldToIndex: ([x, y, z]) => [(x - 20) / 0.25, (y + 10) / 0.5, z],
      },
    };
  }
  worldToCanvas([x, y]) { return [900 - y * 4, 20 + x * 4]; }
  canvasToWorld([x, y]) { return [(y - 20) / 4, (900 - x) / 4, 0]; }
}

test('annotation projection round trips through pan, zoom and rotation in source pixel centers', () => {
  const viewport = new SyntheticStack();
  const frame = { columns: 120, rows: 80 };
  const source = { x: 15.5, y: 43.25 };
  assert.deepEqual(sourcePoint(viewport, frame, canvasPoint(viewport, source)), source);
  const outside = canvasPoint(viewport, { x: -5, y: 40 });
  assert.equal(sourcePoint(viewport, frame, outside), null);
  assert.deepEqual(sourcePoint(viewport, frame, outside, true), { x: 0, y: 40 });
});

test('a pending frame or unsupported viewport cannot inherit the previously displayed image', () => {
  const viewport = new SyntheticStack();
  const cornerstone = { StackViewport: SyntheticStack, metaData: { get: () => instance } };
  let currentViewport = viewport;
  const services = {
    viewportGridService: { getActiveViewportId: () => 'test-pane' },
    cornerstoneViewportService: { getCornerstoneViewport: () => currentViewport },
  };
  assert.equal(readActiveFrame(cornerstone, services).imageId, 'dicomfile:0');
  viewport.requestedImage = 'dicomfile:1';
  assert.equal(readActiveFrame(cornerstone, services), null);
  viewport.currentImage = viewport.requestedImage;
  assert.equal(readActiveFrame(cornerstone, services).imageId, 'dicomfile:1');
  currentViewport = {};
  assert.equal(readActiveFrame(cornerstone, services), null);
});
