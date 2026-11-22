import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const expected = 'f1f5bb16343420a45b36dadf8d3dd35ba4cd968943efed4d9a08e3b6ed2a8fca';
const canonical = new URL('../../demo/Lisfranc-Review.html', import.meta.url);
const bundled = new URL('../workspaces/demo/Lisfranc-Review.html', import.meta.url);
const noticeName = 'THIRD-PARTY-NOTICES.txt';

let bytes;
let needsCopy = true;
try {
  bytes = await readFile(canonical);
} catch (failure) {
  if (failure.code !== 'ENOENT') throw failure;
  // An installed package already carries the validated generated asset.
  bytes = await readFile(bundled);
  needsCopy = false;
}

const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== expected) throw new Error('Expected the reviewed synthetic Demo HTML. Check the release source before packaging.');
const notice = await readFile(new URL(noticeName, needsCopy ? canonical : bundled), 'utf8');
if (!notice.trim()) throw new Error('Expected the Demo third-party notices.');
if (needsCopy) {
  await writeFile(bundled, bytes);
  await writeFile(new URL(noticeName, bundled), notice);
}
