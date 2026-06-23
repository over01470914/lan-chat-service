import assert from 'node:assert/strict';
import { categorizeFile, fuzzyMatch, fuzzyScore, getFilePreviewKind, shortType } from '../public/chat-utils.js';

const categoryCases = [
  ['photo.PNG', 'image/png', 'image'],
  ['clip.mov', 'video/quicktime', 'video'],
  ['notes.md', '', 'text'],
  ['Quarterly Deck.PPTX', '', 'document'],
  ['bundle.apk', '', 'archive'],
  ['mystery.bin', 'application/octet-stream', 'other'],
];

for (const [name, mimeType, expected] of categoryCases) {
  assert.equal(categorizeFile(name, mimeType), expected, `${name} should be ${expected}`);
}

assert.equal(getFilePreviewKind('demo.mp4', 'video/mp4'), 'video');
assert.equal(getFilePreviewKind('diagram.jpeg', 'image/jpeg'), 'image');
assert.equal(getFilePreviewKind('notes.txt', 'text/plain'), 'icon');
assert.equal(shortType('Report.PDF', 'document'), 'pdf');

assert.equal(fuzzyMatch('delivery-summary.json', 'delivry sumary'), true, 'fuzzy filename typo match');
assert.equal(fuzzyMatch('alpha-only-message', 'alpa msg'), true, 'fuzzy chat content typo match');
assert.equal(fuzzyMatch('PetLink-Demo-Codex.apk', 'ptlnk apk'), true, 'subsequence fuzzy match');
assert.equal(fuzzyMatch('meeting-notes.md', 'invoice'), false, 'unrelated query does not match');
assert.ok(fuzzyScore('summary', 'sumary') > fuzzyScore('summary', 'invoice'), 'closer typo has higher score');

console.log(JSON.stringify({ ok: true, checks: ['category mapping', 'preview kind', 'fuzzy filename search', 'fuzzy chat search'] }, null, 2));
