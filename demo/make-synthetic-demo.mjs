import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const defaultPath = fileURLToPath(new URL('./Lisfranc-Review.html', import.meta.url));
const input = resolve(process.argv[2] ?? defaultPath);
const output = resolve(process.argv[3] ?? defaultPath);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = '5e2d673c15b25c01e409a27c10298d309bd47a62aea195bc326c80a959d6aeee';
const html = await readFile(input, 'utf8');
const isOriginal = sha256(html) === originalHash;
assert.ok(!isOriginal || input !== output, 'Preserve the original input. Choose a separate output file.');

const [match, ...extra] = html.matchAll(/<script>window\.PORTABLE_DATA=([\s\S]*?);<\/script>/g);
assert.ok(match && extra.length === 0, 'Expected a single portable payload.');
const source = JSON.parse(match[1]);
assert.ok(isOriginal || source.synthetic_demo === true, 'Use the reviewed 0.2.0 HTML or its generated synthetic variant.');

const size = 256;
const coord = (x, y) => ({ x, y });
const point = ([x, y]) => coord(x, y);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function png(scanlines) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function ellipse(x, y, cx, cy, rx, ry) {
  return Math.hypot((x - cx) / rx, (y - cy) / ry);
}

function capsule(ax, ay, bx, by, startRadius, endRadius, strength = 1) {
  const dx = bx - ax;
  const dy = by - ay;
  const span2 = dx * dx + dy * dy;
  return (x, y) => {
    const fraction = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / span2));
    const radius = startRadius + fraction * (endRadius - startRadius);
    const distance = Math.hypot(x - ax - fraction * dx, y - ay - fraction * dy) / radius;
    if (distance >= 1.08) return 0;
    const taper = Math.min(1, (1.08 - distance) * 15);
    const cortex = 68 * Math.exp(-((distance - 0.89) ** 2) / 0.012);
    const centre = 64 + 11 * Math.cos(x * 0.41 - y * 0.22) * Math.sin(y * 0.69 + x * 0.17);
    return strength * taper * (centre + cortex);
  };
}

function apGeometry(offset) {
  const rays = [[61, 73, 148, 9], [105, 108, 144, 8], [139, 136, 155, 8], [165, 155, 160, 7], [186, 169, 167, 7]];
  const bones = rays.flatMap(([toe, base, y, width], i) => {
    const head = 62 + 6 * i;
    const spread = i === 1 ? offset : 0;
    return [
      capsule(toe, head, base + spread, y, width, width + 1),
      capsule(toe - 2, head - 16, toe - 5, head - 29, width * 0.79, width * 0.71),
      capsule(toe - 6, head - 38, toe - 7, head - 47, width * 0.70, width * 0.63),
    ];
  });
  bones.push(
    capsule(79, 165, 80, 178, 11, 14),
    capsule(103, 163, 106, 174, 9, 10),
    capsule(128, 173, 132, 187, 11, 12),
    capsule(154, 179, 151, 193, 12, 14),
    capsule(91, 199, 118, 203, 13, 16, 0.85),
    capsule(120, 211, 119, 233, 19, 17, 0.8),
  );
  return {
    bones,
    tissue: (x, y) => Math.min(ellipse(x, y, 118, 100, 94, 91), ellipse(x, y, 119, 189, 61, 57)),
  };
}

function lateralGeometry(offset) {
  const bones = [
    capsule(59, 40, 65, 124, 14, 14, 0.86),
    capsule(73, 64, 77, 130, 6, 8, 0.52),
    capsule(65, 151, 92, 149, 13, 12),
    capsule(54, 177, 92, 170, 17, 11),
    capsule(99, 151, 111, 154, 10, 11),
    capsule(117, 154, 130, 157, 9, 10),
    capsule(141, 156 + offset, 202, 166, 8, 7),
    capsule(145, 163, 200, 172, 6, 5, 0.53),
    capsule(211, 168, 225, 172, 6, 4),
    capsule(232, 172, 240, 174, 4, 4),
  ];
  return {
    bones,
    tissue: (x, y) => Math.min(
      ellipse(x, y, 66, 90, 34, 82),
      ellipse(x, y, 86, 160, 66, 40),
      ellipse(x, y, 173, 161 + offset / 2, 79, 26),
    ),
  };
}

function render(caseId, view) {
  const offset = (caseId % 7) - 3;
  const { bones, tissue } = view === 'ap' ? apGeometry(offset) : lateralGeometry(offset);
  const scanlines = Buffer.alloc(size * (size + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size + 1) + 1;
    for (let x = 0; x < size; x++) {
      const skin = 40 * Math.min(1, Math.max(0, (1.02 - tissue(x, y)) * 9));
      const grain = ((x * 103 ^ y * 251 ^ caseId * 11) % 9) - 4;
      const bone = bones.reduce((density, layer) => density + layer(x, y), 0);
      scanlines[row + x] = Math.round(Math.min(245, 12 + skin + grain + bone));
    }
  }
  return png(scanlines);
}

const cases = [];
const proposals = [];
for (let id = 1; id <= 10; id++) {
  const serial = String(id).padStart(2, '0');
  const caseKey = `synthetic-foot-${serial}`;
  const laterality = 'L';
  const pairing_provenance = 'Two generated schematics for the same synthetic review fixture';
  const frames = ['ap', 'lateral'].map((view, index) => {
    const bytes = render(id, view);
    return {
      image_id: `${caseKey}-${view}`,
      image: `data:image/png;base64,${bytes.toString('base64')}`,
      sha256: sha256(bytes),
      bytes: bytes.length,
      width: size,
      height: size,
      view,
      laterality,
      frame_id: id * 1000 + index + 1,
      paired: true,
      pairing_provenance,
      calibration: { status: 'unavailable', note: 'Generated schematic. Distances are pixels.' },
    };
  });
  const [ap, lateral] = frames;
  cases.push({ ...ap, image_id: caseKey, label: `Synthetic paired case ${serial}`, frames });

  const offset = (id % 7) - 3;
  proposals.push({
    image_id: ap.image_id,
    case_image_id: caseKey,
    frame_id: ap.frame_id,
    portable_prediction_id: id,
    model: 'Synthetic starter',
    proposal_label: 'Synthetic starter',
    source_name: 'Synthetic starter',
    source_version: 'example 1',
    stage: 'synthetic-fixture',
    response: {
      status: 'ok',
      landmarks: {
        c1_proximal: coord(92, 176),
        c1_distal: coord(90, 160),
        m2_proximal: coord(98 + offset, 145),
        m2_distal: coord(98 + offset, 134),
      },
      tangent_point: coord(98 + offset, 143),
      cortex_relation: 'separated',
    },
    clinical_findings: {
      schema_version: 1,
      measurements: {
        soft_tissue: { frame_id: lateral.frame_id, points: [[145, 147 + offset], [144, 136 + offset]].map(point) },
      },
    },
  });
}

const attributions = [{
  dataset: 'Generated AP and lateral foot schematics',
  creator: 'Lisfranc demo fixture generator',
  changes: 'Illustrations and example landmarks generated specifically to exercise this offline review interface.',
}];
const data = {
  synthetic_demo: true,
  cases,
  proposals,
  demonstrations: {},
  attribution: { sources: attributions, notes: 'Synthetic review exercise. This demo contains no radiographs or model outputs.' },
  additional_attribution: attributions,
  fingerprint: `synthetic-${sha256(cases.flatMap(item => item.frames.map(frame => frame.sha256)).join(',')).slice(0, 16)}`,
};

let shell = html.slice(0, match.index) + '<!--HTMLOFFLINEPAYLOAD-->' + html.slice(match.index + match[0].length);
if (isOriginal) {
  // The packaged application contains an opening-angle lookup specific to the original films.
  // It is the only case-linked field outside the isolated data payload.
  const rotationMap = /\{(?:"?[0-9a-f]{64}"?:-?\d{1,3},){9}"?[0-9a-f]{64}"?:-?\d{1,3}\}/g;
  assert.equal([...shell.matchAll(rotationMap)].length, 1, 'Expected exactly one original case-linked rotation table.');
  shell = shell.replace(rotationMap, '{}');

  const wording = new Map([
    ['Public radiographs', 'Synthetic foot projection schematics'],
    ['Portable demo', 'Synthetic offline demo'],
    ['Source-verified paired public radiograph', 'Paired synthetic projection schematic'],
    ['Public pilot radiograph', 'Synthetic projection schematic'],
    ['Public raster radiograph; portable demo', 'Generated synthetic schematic; portable demo'],
    ['Embedded full-grid PNG render of public DICOM', 'Embedded generated schematic'],
    ['Embedded original public raster', 'Embedded synthetic schematic'],
    ['Display render of resized public DICOM; original pixel grid, untrusted release calibration excluded', 'Rendered synthetic fixture; pixel units'],
    ['AP/lateral views share source-verified case provenance. View labels were screened for this demo.', 'The generated AP and lateral views form one synthetic review fixture.'],
    ['One public AP candidate per case. This demo does not perform view detection.', 'The synthetic fixture generator assigns view labels.'],
    ['Frozen public-source selection', 'Synthetic fixture'],
    ['Frozen pilot candidate; not an image classifier.', 'View labels are assigned by the synthetic fixture generator.'],
    ['Model proposal available', 'Synthetic example available'],
    ['Machine proposal', 'Synthetic example'],
    ['DEMO paired public foot', 'Synthetic paired foot'],
    ['This case has no supported single-frame radiographs.', 'This case has no supported synthetic view.'],
    ['Original images and drafts stay in the demo file.', 'Generated images and example landmarks stay in the demo file.'],
    ['review_03 snapshot', 'fixture starter'],
    ['gpt-6.1-sol-xhigh', 'synthetic-starter-example'],
    ['gpt-6.1-sol', 'synthetic-starter'],
    ['"Astra"', '"Synthetic starter"'],
  ]);
  for (const [from, to] of wording) {
    assert.ok(shell.includes(from), `Missing the expected demo label: ${from}`);
    shell = shell.replaceAll(from, to);
  }
  const originalGuide = /"Ten UNIFESP public studies,[^"]*":"HVAngleEst v5,[^"]*"/;
  assert.match(shell, originalGuide);
  shell = shell.replace(originalGuide, '"Ten generated fixtures each include an AP and lateral schematic. Measurements are in pixels. The sample landmarks are hand-authored workflow examples.":"Generated projection schematics and sample landmarks."');

  for (const item of source.cases) {
    for (const frame of item.frames) {
      for (const field of ['image_id', 'file_name', 'dicom_file_name', 'sha256', 'dicom_sha256']) {
        assert.ok(!frame[field] || !shell.includes(frame[field]), 'An original frame reference remains outside the data payload.');
      }
    }
  }
}
assert.ok(!shell.includes('data:image/'), 'Image data must only come from the generated payload.');
const payload = `<script>window.PORTABLE_DATA=${JSON.stringify(data).replaceAll('</script', '<\\/script')};</script>`;
const sanitized = shell.replace('<!--HTMLOFFLINEPAYLOAD-->', () => payload);
await writeFile(output, sanitized, 'utf8');
console.log(`Wrote 10 synthetic paired cases and 20 generated projection schematics. SHA-256 ${sha256(sanitized)}`);
