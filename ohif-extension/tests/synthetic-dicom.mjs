import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const transferSyntax = '1.2.840.10008.1.2.1';
const digitalXray = '1.2.840.10008.5.1.4.1.1.1.1';
const multiframeGray = '1.2.840.10008.5.1.4.1.1.7.2';
const uid = ordinal => `2.25.${250981981353660330135830176371284000000n + BigInt(ordinal)}`;
const rows = 256;
const columns = 256;

function integer(value, size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUIntLE(value, 0, size);
  return bytes;
}

function element(tag, vr, value) {
  let data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'ascii');
  if (data.length % 2) {
    const padding = vr === 'OB' || vr === 'UI' ? 0 : 0x20;
    data = Buffer.concat([data, Buffer.from([padding])]);
  }
  const long = vr === 'OB' || vr === 'OW';
  const header = Buffer.alloc(long ? 12 : 8);
  header.writeUInt16LE(tag >>> 16, 0);
  header.writeUInt16LE(tag & 0xffff, 2);
  header.write(vr, 4, 2, 'ascii');
  header.writeUIntLE(data.length, long ? 8 : 6, long ? 4 : 2);
  return Buffer.concat([header, data]);
}

// A smooth gradient, stripes, and simple rectangles generated from coordinates.
// Each stack image or frame has a different stripe position.
function renderFrame(ordinal) {
  const bytes = Buffer.alloc(rows * columns);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const box = x > 56 && x < 194 && y > 56 && y < 194;
      const stripe = Math.abs(x - 48 * ordinal) < 3 || Math.abs(y - 192) < 3;
      bytes[y * columns + x] = stripe ? 245 : 35 + Math.floor((x + y) / 7) + (box ? 65 : 0);
    }
  }
  return bytes;
}

function makeFile(kind, instance, { view = 'AP', calibrated = kind === 'calibrated' } = {}) {
  const groups = { calibrated: 100, pixels: 200, multiframe: 300 };
  const offset = groups[kind];
  const study = uid(offset);
  const series = uid(offset + 10);
  const sop = uid(offset + 20 + instance);
  const isMultiframe = kind === 'multiframe';
  const sopClass = isMultiframe ? multiframeGray : digitalXray;
  const modality = isMultiframe ? 'OT' : 'DX';
  const filename = `synthetic-lisfranc-${kind}-${instance}.dcm`;
  const meta = Buffer.concat([
    element(0x00020001, 'OB', Buffer.from([0, 1])),
    element(0x00020002, 'UI', sopClass),
    element(0x00020003, 'UI', sop),
    element(0x00020010, 'UI', transferSyntax),
    element(0x00020012, 'UI', uid(1)),
  ]);
  const data = [
    [0x00080008, 'CS', 'DERIVED\\SECONDARY'],
    [0x00080016, 'UI', sopClass],
    [0x00080018, 'UI', sop],
    [0x00080020, 'DA', '20000101'],
    [0x00080030, 'TM', '120000'],
    [0x00080060, 'CS', modality],
    [0x00080064, 'CS', 'SYN'],
    [0x00081030, 'LO', `Lisfranc synthetic ${kind}`],
    [0x0008103e, 'LO', `Synthetic ${kind} stack`],
    [0x00100010, 'PN', 'SYNTHETIC^LISFRANC'],
    [0x00100020, 'LO', 'SYNTHETIC-LISFRANC'],
    [0x00180015, 'CS', 'FOOT'],
    ...(view ? [[0x00185101, 'CS', view]] : []),
    [0x0020000d, 'UI', study],
    [0x0020000e, 'UI', series],
    [0x00200011, 'IS', 1],
    [0x00200013, 'IS', instance],
    [0x00200020, 'CS', 'L\\F'],
    [0x00200032, 'DS', `0\\0\\${instance - 1}`],
    [0x00200037, 'DS', '1\\0\\0\\0\\1\\0'],
    [0x00200052, 'UI', uid(offset + 30)],
    [0x00280002, 'US', integer(1, 2)],
    [0x00280004, 'CS', 'MONOCHROME2'],
    ...(isMultiframe ? [[0x00280008, 'IS', 2]] : []),
    [0x00280010, 'US', integer(rows, 2)],
    [0x00280011, 'US', integer(columns, 2)],
    ...(calibrated
      ? [[0x00280030, 'DS', '0.25\\0.5'], [0x00280a02, 'CS', 'GEOMETRY']]
      : []),
    [0x00280100, 'US', integer(8, 2)],
    [0x00280101, 'US', integer(8, 2)],
    [0x00280102, 'US', integer(7, 2)],
    [0x00280103, 'US', integer(0, 2)],
    [0x00280301, 'CS', 'NO'],
    [0x00281050, 'DS', 128],
    [0x00281051, 'DS', 256],
    [0x7fe00010, 'OB', isMultiframe ? Buffer.concat([renderFrame(1), renderFrame(2)]) : renderFrame(instance)],
  ].sort((first, second) => first[0] - second[0]);
  return {
    name: filename,
    mimeType: 'application/dicom',
    buffer: Buffer.concat([
      Buffer.alloc(128),
      Buffer.from('DICM'),
      element(0x00020000, 'UL', integer(meta.length, 4)),
      meta,
      ...data.map(args => element(...args)),
    ]),
  };
}

export function syntheticDicomFiles(kind, options) {
  switch (kind) {
    case 'calibrated':
    case 'pixels':
      return [makeFile(kind, 1, options), makeFile(kind, 2, options)];
    case 'multiframe':
      return [makeFile(kind, 1, options)];
    default:
      throw new Error('Use calibrated, pixels, or multiframe.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node tests/synthetic-dicom.mjs OUTPUT_DIRECTORY');
  }
  const directory = resolve(process.argv[2]);
  await mkdir(directory, { recursive: true });
  for (const kind of ['calibrated', 'pixels', 'multiframe']) {
    for (const file of syntheticDicomFiles(kind)) {
      await writeFile(resolve(directory, file.name), file.buffer);
    }
  }
  console.log(`Wrote five synthetic DICOM files to ${directory}`);
}
