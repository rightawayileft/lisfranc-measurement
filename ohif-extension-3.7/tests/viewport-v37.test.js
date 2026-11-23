import assert from 'node:assert/strict';
import test from 'node:test';
import { readActiveFrame, resolveFrame, subscribeViewportChanges } from '../workspaces/clinical/viewport.js';

function createService(EVENTS) {
  const listeners = new Map();
  return {
    EVENTS,
    subscribe(event, listener) {
      if (!Object.values(EVENTS).includes(event)) throw new Error('Unsupported OHIF event');
      listeners.set(event, listener);
      return { unsubscribe: () => listeners.delete(event) };
    },
    emit(event) {
      listeners.get(event)?.(event);
    },
  };
}

test('tracks active viewport, layout, grid and image updates on the OHIF 3.7 event surface', () => {
  const grid = createService({
    ACTIVE_VIEWPORT_ID_CHANGED: 'event::activeviewportidchanged',
    GRID_STATE_CHANGED: 'event::gridStateChanged',
    LAYOUT_CHANGED: 'event::layoutChanged',
  });
  const viewports = createService({
    VIEWPORT_DATA_CHANGED: 'event::cornerstoneViewportService:viewportDataChanged',
  });
  const updates = [];
  const stop = subscribeViewportChanges(grid, viewports, event => updates.push(event));
  const events = [...Object.values(grid.EVENTS), ...Object.values(viewports.EVENTS)];
  const emitChanges = () => {
    Object.values(grid.EVENTS).forEach(grid.emit);
    Object.values(viewports.EVENTS).forEach(viewports.emit);
  };
  emitChanges();
  assert.deepEqual(updates, events);

  stop();
  emitChanges();
  assert.deepEqual(updates, events);
});

test('blocks unsafe OHIF 3.7 multi-frame paths for both candidate and active frames', () => {
  const instance = {
    StudyInstanceUID: '2.25.70101', SeriesInstanceUID: '2.25.70102', SOPInstanceUID: '2.25.70103',
    NumberOfFrames: 2, Modality: 'DX', ViewPosition: 'DP',
  };
  const dimensions = [120, 80];
  class SyntheticStack {
    getCurrentImageId() { return this.imageId; }
    getCornerstoneImage() { return { imageId: this.imageId }; }
    getImageData() {
      return { dimensions, imageData: { worldToIndex: point => point, indexToWorld: point => point } };
    }
  }
  const viewport = new SyntheticStack();
  const services = {
    viewportGridService: { getActiveViewportId: () => 'test-pane' },
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
  };
  let metadata = instance;
  const cornerstone = { StackViewport: SyntheticStack, metaData: { get: () => metadata } };
  const blockedIds = [
    'dicomfile:0&frame=1',
    'dicomfile:0&frame=2',
    'wadouri:https://example.invalid/dicom?requestType=WADO&frameNumber=1',
    'dicomweb:https://example.invalid/dicom?frame=1',
    'unknown:synthetic/frames/1',
    'wadors:synthetic?frame=1',
    'wadors:https://example.invalid/dicom?locator=/frames/1',
    'wadors:https://example.invalid/dicom#/frames/1',
    'wadors:https://example.invalid/dicom/frames/1/other',
    'wadors:https://frames/1',
  ];
  for (const imageId of blockedIds) {
    viewport.imageId = imageId;
    assert.equal(resolveFrame(instance, imageId, dimensions), null);
    assert.equal(readActiveFrame(cornerstone, services), null);
  }
  viewport.imageId = 'wadors:https://example.invalid/dicom/frames/2?ignore=/frames/1';
  assert.equal(resolveFrame(instance, viewport.imageId, dimensions).frameNumber, 2);
  assert.equal(readActiveFrame(cornerstone, services).frame.frameNumber, 2);

  for (const NumberOfFrames of [undefined, 1]) {
    metadata = { ...instance, NumberOfFrames };
    for (const imageId of blockedIds.slice(0, 4)) {
      viewport.imageId = imageId;
      assert.equal(resolveFrame(metadata, imageId, dimensions), null);
      assert.equal(readActiveFrame(cornerstone, services), null);
    }
    viewport.imageId = 'dicomfile:0';
    assert.equal(readActiveFrame(cornerstone, services).frame.frameNumber, 1);
  }
});
