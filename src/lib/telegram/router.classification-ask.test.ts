import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import type { TelegramSessionState } from "@/lib/db/schema";
import { handleUpdate, type RouterDeps } from "./router";

const mocks = vi.hoisted(() => ({
  applyClassificationAnswerByIndex: vi.fn(),
  processAskForUser: vi.fn(),
  skipClassificationQuestion: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("@/lib/classification/ask-user", () => ({
  applyClassificationAnswerByIndex: mocks.applyClassificationAnswerByIndex,
  processAskForUser: mocks.processAskForUser,
  skipClassificationQuestion: mocks.skipClassificationQuestion,
}));

vi.mock("@/lib/telegram/session", () => ({
  getSession: mocks.getSession,
  upsertSession: mocks.upsertSession,
  clearSession: mocks.clearSession,
  mergeDraft: (state: TelegramSessionState, patch: Partial<TelegramSessionState>) => ({
    ...state,
    draft: { ...state.draft, ...patch },
  }),
}));

function buildClient(): { client: TelegramClient; sent: { text: string }[] } {
  const sent: { text: string }[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (opts) => {
      sent.push({ text: opts.text });
      return { message_id: sent.length };
    },
    editMessage: async () => {},
    answerCallbackQuery: async () => {},
    getFile: async (id) => ({ file_id: id, file_unique_id: id, file_path: "x.jpg" }),
    downloadFile: async () => Buffer.from(""),
    getMe: async () => ({ id: 1, is_bot: true, first_name: "Bot", username: "bot" }),
    setWebhook: async () => {},
    deleteWebhook: async () => {},
  };
  return { client, sent };
}

function buildDeps(): RouterDeps {
  return {
    userId: 42,
    listAccounts: async () => [],
    listCategories: async () => [{ slug: "hogar", name: "Hogar", parentSlug: "vivienda" }],
    parseNlu: async () => {
      throw new Error("NLU should not run");
    },
    runOcr: async () => {
      throw new Error("OCR should not run");
    },
    transcribeVoice: async () => {
      throw new Error("STT should not run");
    },
  };
}

function callbackUpdate(data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: 999, is_bot: false, first_name: "User" },
      chat_instance: "x",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 200, type: "private" },
      },
    },
  };
}

describe("handleUpdate — classification ask callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyClassificationAnswerByIndex.mockResolvedValue({ ok: true, categorySlug: "hogar" });
    mocks.skipClassificationQuestion.mockResolvedValue({ ok: true });
    mocks.processAskForUser.mockResolvedValue({
      askedTxId: null,
      skipped: "no_eligible",
      expiredCount: 0,
      requeuedCount: 0,
    });
    mocks.getSession.mockResolvedValue(null);
    mocks.clearSession.mockResolvedValue(undefined);
  });

  it("applies a category from cq: callback even with no session", async () => {
    const { client, sent } = buildClient();
    await handleUpdate(callbackUpdate("cq:55:0"), client, buildDeps());
    expect(mocks.applyClassificationAnswerByIndex).toHaveBeenCalledWith({
      userId: 42,
      txId: 55,
      index: 0,
    });
    expect(sent[0]?.text).toMatch(/Hogar/);
    expect(mocks.clearSession).toHaveBeenCalledWith(200);
    expect(mocks.processAskForUser).toHaveBeenCalledWith(42);
  });

  it("skips on cq:{txId}:s without requiring a session", async () => {
    const { client, sent } = buildClient();
    await handleUpdate(callbackUpdate("cq:55:s"), client, buildDeps());
    expect(mocks.skipClassificationQuestion).toHaveBeenCalledWith({ userId: 42, txId: 55 });
    expect(sent[0]?.text).toMatch(/después/);
  });
});
