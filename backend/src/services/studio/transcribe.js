'use strict';

/**
 * Audio -> text, reusing the fal key we already have.
 *
 * The creator can speak an idea instead of typing it. Live dictation happens in
 * the browser (Web Speech API); an uploaded audio FILE comes here: we push the
 * bytes to fal storage and run fal's Whisper, so there is no new provider or key
 * to configure — the same FAL_KEY that trains and renders also transcribes.
 */

const { FalProvider } = require('../../../worker/providers/fal');

const WHISPER_MODEL = process.env.FAL_WHISPER_MODEL || 'fal-ai/whisper';

class TranscribeError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

async function transcribe(buffer, contentType = 'audio/webm') {
  if (!process.env.FAL_KEY) throw new TranscribeError('Transcription needs FAL_KEY.', { status: 503, code: 'NO_FAL' });
  if (!buffer || !buffer.length) throw new TranscribeError('No audio to transcribe.');

  const provider = new FalProvider({ apiKey: process.env.FAL_KEY });
  const ext = String(contentType || '').split('/')[1]?.split(';')[0] || 'webm';
  const audioUrl = await provider.uploadToFalStorage(buffer, { filename: `idea.${ext}`, contentType });

  const handle = await provider.submit('transcribe', { audio_url: audioUrl }, { model: WHISPER_MODEL });
  const out = await provider.waitForResult(handle, { timeoutMs: 180_000 });

  const text = out && (
    out.text
    || out.transcription
    || (Array.isArray(out.chunks) ? out.chunks.map((c) => c && c.text).filter(Boolean).join(' ') : '')
  );
  return String(text || '').replace(/\s+/g, ' ').trim();
}

module.exports = { transcribe, TranscribeError };
