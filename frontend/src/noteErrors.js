// What a failed sermon note says on the Sermon Notes page, by the note's error code.

// A YouTube link goes through the YouTube helper first, then a direct download; these mean both failed.
export const YOUTUBE_REFUSED = "YouTube wouldn't let us download this video. Upload the video file instead (in YouTube Studio: Content > the video > ⋮ > Download).";
export const NOTE_ERRORS = {
  youtube_blocked: YOUTUBE_REFUSED,
  download_failed: YOUTUBE_REFUSED,
  youtube_unavailable: 'That YouTube video is private or unavailable.',
  too_long: 'The video is longer than the 90-minute limit.',
  no_audio: 'The file has no audio track.',
  no_speech: 'No speech was found in the audio.',
  interrupted: 'Processing was interrupted. Try again.',
};

export const noteErrorMessage = code => NOTE_ERRORS[code] || `Processing failed (${code}).`;
