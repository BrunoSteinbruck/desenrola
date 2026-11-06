// Transcrição de áudio (OpenAI Whisper, whisper-1) via REST.
export const NOT_TRANSCRIBED = '[áudio não transcrito]';

export async function transcribe(audio: Buffer, mimetype = 'audio/ogg'): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') ? 'm4a' : 'ogg';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype.split(';')[0] }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn('[whisper]', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.warn('[whisper] falhou', err);
    return null;
  }
}
