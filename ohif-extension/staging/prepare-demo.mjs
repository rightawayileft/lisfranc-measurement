import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const expected = '41c09b237643bd1755a62798d731ca1fdea28ad9358a0ec8cc486341cb637c4a';
const canonical = new URL('../../demo/Lisfranc-Review.html', import.meta.url);
const bundled = new URL('../workspaces/demo/Lisfranc-Review.html', import.meta.url);
const noticeName = 'THIRD-PARTY-NOTICES.txt';

let bytes;
let needsCopy = true;
try {
  bytes = await readFile(canonical);
} catch (failure) {
  if (failure.code !== 'ENOENT') throw failure;
  // An installed package already carries the validated Demo asset.
  bytes = await readFile(bundled);
  needsCopy = false;
}

const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== expected) throw new Error('Expected the reviewed real-image Demo HTML. Check the release source before packaging.');
const notice = await readFile(new URL(noticeName, needsCopy ? canonical : bundled), 'utf8');
const noticeHash = createHash('sha256').update(notice.replaceAll('\r\n', '\n')).digest('hex');
if (noticeHash !== '0c70d99fa53ff1781886e69c3770039a49bd9e9f26b1b7923c6b55c930390deb') {
  throw new Error('Expected the verified Demo image credits and third-party notices.');
}
if (needsCopy) {
  await writeFile(bundled, bytes);
  await writeFile(new URL(noticeName, bundled), notice);
}
