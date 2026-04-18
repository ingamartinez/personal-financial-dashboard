import { describe, expect, it } from "vitest";
import { transcribeAudio } from "./transcribe";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("transcribeAudio", () => {
  it("calls Groq with the right endpoint, auth and language default", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody: FormData | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers.authorization ?? "";
      capturedBody = (init?.body as FormData) ?? null;
      return jsonResponse({ text: "pagué 45 mil en el restaurante" });
    };

    const result = await transcribeAudio({
      audioBuffer: Buffer.from("fake-ogg-bytes"),
      mimeType: "audio/ogg",
      apiKey: "test-key",
      fetchImpl,
    });

    expect(result.text).toBe("pagué 45 mil en el restaurante");
    expect(result.model).toBe("whisper-large-v3-turbo");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.get("language")).toBe("es");
    expect(capturedBody!.get("model")).toBe("whisper-large-v3-turbo");
    expect(capturedBody!.get("response_format")).toBe("json");
    expect(capturedBody!.get("file")).toBeInstanceOf(Blob);
  });

  it("trims whitespace from the transcription", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ text: "  hola mundo  \n" });
    const result = await transcribeAudio({
      audioBuffer: Buffer.from("x"),
      mimeType: "audio/ogg",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(result.text).toBe("hola mundo");
  });

  it("uses a custom model when provided", async () => {
    let capturedModel = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedModel = ((init?.body as FormData).get("model") as string) ?? "";
      return jsonResponse({ text: "test" });
    };
    const result = await transcribeAudio({
      audioBuffer: Buffer.from("x"),
      mimeType: "audio/ogg",
      apiKey: "test-key",
      model: "whisper-large-v3",
      fetchImpl,
    });
    expect(capturedModel).toBe("whisper-large-v3");
    expect(result.model).toBe("whisper-large-v3");
  });

  it("throws on API error (with status and truncated body)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("rate limit exceeded", { status: 429 });
    await expect(
      transcribeAudio({
        audioBuffer: Buffer.from("x"),
        mimeType: "audio/ogg",
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("Groq STT API error 429");
  });

  it("throws when the model returns empty text", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ text: "   " });
    await expect(
      transcribeAudio({
        audioBuffer: Buffer.from("x"),
        mimeType: "audio/ogg",
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow("empty transcription");
  });

  it("throws when GROQ_API_KEY is not configured", async () => {
    const prev = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      await expect(
        transcribeAudio({
          audioBuffer: Buffer.from("x"),
          mimeType: "audio/ogg",
          fetchImpl: async () => jsonResponse({ text: "ok" }),
        }),
      ).rejects.toThrow("GROQ_API_KEY is not set");
    } finally {
      if (prev !== undefined) process.env.GROQ_API_KEY = prev;
    }
  });
});
