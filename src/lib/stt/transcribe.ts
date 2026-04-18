export type TranscribeResult = {
  text: string;
  durationMs: number;
  model: string;
};

// Groq hosts Whisper with the OpenAI-compatible transcription endpoint. The
// `turbo` variant is ~10x faster than `large-v3` and still handles Spanish well
// enough for short Telegram voice notes (<60s). Swap via `model` arg if a
// longer note needs the higher-accuracy variant.
const DEFAULT_MODEL = "whisper-large-v3-turbo";
const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

function fileNameFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "audio.ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  if (mimeType.includes("webm")) return "audio.webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
  return "audio.bin";
}

/**
 * Transcribe a short audio clip via Groq Whisper. Mirrors the wrapper style of
 * `transaction-nlu.ts` / `ocr.ts`: pure function, `fetchImpl` injectable for
 * tests, API key resolved from env as fallback.
 *
 * Caller is responsible for enforcing a duration cap BEFORE downloading —
 * Telegram already gives `voice.duration` in seconds, so this wrapper stays
 * provider-agnostic and does not re-check.
 */
export async function transcribeAudio(opts: {
  audioBuffer: Buffer;
  mimeType: string;
  language?: "es" | "en";
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  fileName?: string;
}): Promise<TranscribeResult> {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const language = opts.language ?? "es";
  const fileName = opts.fileName ?? fileNameFromMime(opts.mimeType);

  const start = Date.now();

  const form = new FormData();
  // Buffer extends Uint8Array so it is a valid BlobPart at runtime, but the
  // DOM lib types disagree (ArrayBufferLike vs ArrayBuffer). Copy into a fresh
  // ArrayBuffer-backed Uint8Array to satisfy the type checker.
  const bytes = new Uint8Array(opts.audioBuffer.byteLength);
  bytes.set(opts.audioBuffer);
  const blob = new Blob([bytes], { type: opts.mimeType });
  form.append("file", blob, fileName);
  form.append("model", model);
  form.append("language", language);
  form.append("response_format", "json");

  const res = await doFetch(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq STT API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { text?: string };
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) throw new Error("Groq STT returned empty transcription");

  return {
    text,
    durationMs: Date.now() - start,
    model,
  };
}
