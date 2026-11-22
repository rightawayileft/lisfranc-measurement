import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { compute, footOfPerpendicular, POINT_NAMES } from './geometry.js';
import { canvasPoint, sourcePoint } from './viewport.js';

const COLOR = '#63e6ff';
const PROXY = '#ffc879';

export function Overlay({ active, events, points, relation, spacing, selected, editing, select, save, isCurrent }) {
  const { viewport, frame } = active;
  const svg = useRef(null);
  const drag = useRef(null);
  const [preview, setPreview] = useState(null);
  const [, redraw] = useReducer(n => n + 1, 0);

  useEffect(() => {
    const element = viewport.element;
    let request = 0;
    const refresh = () => {
      if (!request) request = requestAnimationFrame(() => {
        request = 0;
        redraw();
      });
    };
    const renderEvents = [events.IMAGE_RENDERED, events.CAMERA_MODIFIED, events.IMAGE_SPACING_CALIBRATED];
    renderEvents.forEach(event => element.addEventListener(event, refresh));
    const observer = new ResizeObserver(refresh);
    observer.observe(element);
    refresh();
    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      renderEvents.forEach(event => element.removeEventListener(event, refresh));
    };
  }, [events, viewport]);

  useEffect(() => {
    const layer = svg.current;
    if (!editing || !layer) return;
    // Keep the host's mouse/touch annotation handlers out of a Lisfranc gesture.
    const stop = event => event.stopPropagation();
    const mouseEvents = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend'];
    mouseEvents.forEach(event => layer.addEventListener(event, stop));
    return () => mouseEvents.forEach(event => layer.removeEventListener(event, stop));
  }, [editing]);

  function locate(event, clamp) {
    if (!isCurrent()) return null;
    const rect = svg.current.getBoundingClientRect();
    return sourcePoint(viewport, frame, [event.clientX - rect.left, event.clientY - rect.top], clamp);
  }

  function pointerDown(event) {
    if (!editing || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const existing = event.target.dataset.landmark;
    const name = existing || selected;
    const point = name && locate(event, false);
    if (!point) return;
    select(name);
    drag.current = { name, id: event.pointerId, existing: Boolean(existing), x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!existing) setPreview({ name, point });
  }

  function pointerMove(event) {
    if (drag.current?.id !== event.pointerId) return;
    const point = locate(event, true);
    if (point) setPreview({ name: drag.current.name, point });
  }

  function cancel() {
    drag.current = null;
    setPreview(null);
  }

  function pointerUp(event) {
    const gesture = drag.current;
    if (gesture?.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 2;
    const point = locate(event, Boolean(gesture.existing || moved));
    cancel();
    if (point && (!gesture.existing || moved)) save(gesture.name, point);
  }

  const current = isCurrent();
  const shown = preview && editing ? { ...points, [preview.name]: preview.point } : points;
  const [a, b, q, c, d] = POINT_NAMES.map(name => shown[name]);
  const values = compute(shown, relation, spacing);
  const children = [];
  function line(key, p1, p2, color, dash) {
    if (!current || !p1 || !p2) return;
    const [x1, y1] = canvasPoint(viewport, p1);
    const [x2, y2] = canvasPoint(viewport, p2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    children.push(h('line', { key, x1, y1, x2, y2, stroke: '#101820', strokeWidth: 4, opacity: 0.85 }));
    children.push(h('line', { key: key + '-color', x1, y1, x2, y2, stroke: color, strokeWidth: 2, strokeDasharray: dash }));
  }
  line('c1', a, b, COLOR);
  if (values.tangentStatus === 'complete') {
    const foot = values.unsignedMm === null ? footOfPerpendicular(a, b, q) :
      footOfPerpendicular(a, b, q, spacing.col_mm, spacing.row_mm);
    if (foot) {
      line('tangent-gap', foot, q, COLOR);
      line('m2-tangent', { x: a.x + q.x - foot.x, y: a.y + q.y - foot.y },
        { x: b.x + q.x - foot.x, y: b.y + q.y - foot.y }, COLOR, '5 3');
    }
  }
  line('m2-chord', c, d, PROXY, '5 3');
  if (values.proxyStatus === 'complete') {
    const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    const foot = values.proxyUnsignedMm === null ? footOfPerpendicular(a, b, mid) :
      footOfPerpendicular(a, b, mid, spacing.col_mm, spacing.row_mm);
    line('proxy-gap', foot, mid, PROXY, '5 3');
  }
  if (current) POINT_NAMES.forEach((name, index) => {
    if (!shown[name]) return;
    const [cx, cy] = canvasPoint(viewport, shown[name]);
    if (![cx, cy].every(Number.isFinite)) return;
    children.push(h('circle', {
      key: name, cx, cy, r: name === selected && editing ? 7 : 5,
      fill: index < 3 ? COLOR : PROXY, stroke: '#0a1824', strokeWidth: 2, 'data-landmark': name,
    }));
  });

  return createPortal(h('svg', {
    ref: svg, 'data-testid': 'lisfranc-overlay', 'aria-hidden': true,
    style: {
      position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 2,
      pointerEvents: editing && current ? 'auto' : 'none', touchAction: editing ? 'none' : 'auto',
      cursor: editing ? 'crosshair' : undefined,
    },
    onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerUp,
    onPointerCancel: cancel, onLostPointerCapture: cancel,
  }, children), viewport.element);
}
