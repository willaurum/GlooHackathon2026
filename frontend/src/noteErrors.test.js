import assert from 'node:assert/strict';
import test from 'node:test';
import { YOUTUBE_REFUSED, noteErrorMessage } from './noteErrors.js';

test('a YouTube link that could not be downloaded asks for a file upload', () => {
  assert.equal(noteErrorMessage('youtube_blocked'), YOUTUBE_REFUSED);
  assert.equal(noteErrorMessage('download_failed'), YOUTUBE_REFUSED);
  assert.match(YOUTUBE_REFUSED, /^YouTube wouldn't let us download this video\. Upload the video file instead/);
  assert.match(YOUTUBE_REFUSED, /YouTube Studio: Content > the video > ⋮ > Download/);
});

test('other codes keep their own message, and unknown ones show the code', () => {
  assert.equal(noteErrorMessage('youtube_unavailable'), 'That YouTube video is private or unavailable.');
  assert.equal(noteErrorMessage('weird'), 'Processing failed (weird).');
});
