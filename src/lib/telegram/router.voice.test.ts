import { describe, expect, it } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { handleUpdate, MAX_VOICE_DURATION_SECONDS, type RouterDeps } from "./router";

// These tests cover the two router branches that short-circuit BEFORE touching
// the session store — long-audio rejection and STT failure. The happy path
// requires the session DB, which is covered by the e2e/integration suite.

type SentMessage = { chat_id: number; text: string };

function buildClient(): {
  client: TelegramClient;
  sent: SentMessage[];
  getFileCalls: string[];
  downloadCalls: string[];
} {
  const sent: SentMessage[] = [];
  const getFileCalls: string[] = [];
  const downloadCalls: string[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (opts) => {
      sent.push({ chat_id: opts.chat_id, text: opts.text });
      return { message_id: sent.length };
    },
    editMessage: async () => {},
    answerCallbackQuery: async () => {},
    getFile: async (id) => {
      getFileCalls.push(id);
      return { file_id: id, file_unique_id: id, file_path: `voice/${id}.ogg` };
    },
    downloadFile: async (path) => {
      downloadCalls.push(path);
      return Buffer.from("fake-audio-bytes");
    },
  };
  return { client, sent, getFileCalls, downloadCalls };
}

function buildDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    allowlist: new Set([111]),
    listAccounts: async () => [],
    listCategories: async () => [],
    parseNlu: async () => {
      throw new Error("NLU should not run in these tests");
    },
    runOcr: async () => {
      throw new Error("OCR should not run in these tests");
    },
    transcribeVoice: async () => {
      throw new Error("transcribeVoice default — override in each test");
    },
    ...overrides,
  };
}

function voiceUpdate(duration: number): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 222, type: "private" },
      from: { id: 111, is_bot: false, first_name: "A" },
      voice: {
        file_id: "voice-1",
        file_unique_id: "voice-u-1",
        duration,
        mime_type: "audio/ogg",
      },
    },
  };
}

describe("handleUpdate — voice routing", () => {
  it(`rejects audio longer than ${MAX_VOICE_DURATION_SECONDS}s without downloading`, async () => {
    const { client, sent, getFileCalls, downloadCalls } = buildClient();
    let transcribeCalled = false;
    const deps = buildDeps({
      transcribeVoice: async () => {
        transcribeCalled = true;
        return { text: "x", durationMs: 1, model: "m" };
      },
    });

    await handleUpdate(voiceUpdate(MAX_VOICE_DURATION_SECONDS + 1), client, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/muy largo/);
    expect(getFileCalls).toEqual([]);
    expect(downloadCalls).toEqual([]);
    expect(transcribeCalled).toBe(false);
  });

  it("sends a friendly error when STT fails (and does not run NLU)", async () => {
    const { client, sent, getFileCalls, downloadCalls } = buildClient();
    let nluCalled = false;
    const deps = buildDeps({
      parseNlu: async () => {
        nluCalled = true;
        throw new Error("should not reach NLU");
      },
      transcribeVoice: async () => {
        throw new Error("groq 500");
      },
    });

    await handleUpdate(voiceUpdate(10), client, deps);

    // First message: "escuchando…"; second: error.
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toMatch(/Escuchando/);
    expect(sent[1].text).toMatch(/No pude transcribir/);
    expect(getFileCalls).toEqual(["voice-1"]);
    expect(downloadCalls).toEqual(["voice/voice-1.ogg"]);
    expect(nluCalled).toBe(false);
  });

  it("sends an error (and skips NLU) when transcription is blank", async () => {
    const { client, sent } = buildClient();
    let nluCalled = false;
    const deps = buildDeps({
      parseNlu: async () => {
        nluCalled = true;
        throw new Error("should not reach NLU");
      },
      transcribeVoice: async () => ({ text: "   ", durationMs: 10, model: "m" }),
    });

    await handleUpdate(voiceUpdate(5), client, deps);

    expect(sent.at(-1)?.text).toMatch(/No entendí el audio/);
    expect(nluCalled).toBe(false);
  });
});
