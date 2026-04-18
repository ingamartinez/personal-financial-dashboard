import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import type { RouterDeps } from "./router";

// Mock the session module so the router doesn't touch the DB. The whole
// point of this bug fix is a short-circuit that runs BEFORE any session is
// persisted — but the text path still calls getSession() on entry, and the
// guard itself calls clearSession(). Stubbing both keeps this a pure unit
// test; the happy-path session behavior is covered by the integration
// suite (see actions.test.ts).
const { mockGetSession, mockClearSession, mockUpsertSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockClearSession: vi.fn(),
  mockUpsertSession: vi.fn(),
}));

vi.mock("@/lib/telegram/session", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/telegram/session")>("@/lib/telegram/session");
  return {
    ...actual,
    getSession: mockGetSession,
    clearSession: mockClearSession,
    upsertSession: mockUpsertSession,
  };
});

const { handleUpdate } = await import("./router");

type SentMessage = {
  chat_id: number;
  text: string;
  reply_markup?: unknown;
};

function buildClient(): { client: TelegramClient; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (opts) => {
      sent.push({ chat_id: opts.chat_id, text: opts.text, reply_markup: opts.reply_markup });
      return { message_id: sent.length };
    },
    editMessage: async () => {},
    answerCallbackQuery: async () => {},
    getFile: async (id) => ({ file_id: id, file_unique_id: id, file_path: `photo/${id}.jpg` }),
    downloadFile: async () => Buffer.from("fake"),
    getMe: async () => ({ id: 1, is_bot: true, first_name: "Bot", username: "bot" }),
    setWebhook: async () => {},
    deleteWebhook: async () => {},
  };
  return { client, sent };
}

function buildDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    userId: 1,
    listAccounts: async () => [],
    listCategories: async () => [],
    parseNlu: async () => ({
      draft: {
        amountCents: "2000000000000",
        currency: "COP",
        direction: "expense",
        merchant: "iPhone 18",
        description: null,
        occurredOn: null,
        accountId: null,
        categorySlug: null,
        confidence: 0.9,
      },
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    runOcr: async () => {
      throw new Error("runOcr should not be called");
    },
    transcribeVoice: async () => {
      throw new Error("transcribeVoice should not be called");
    },
    ...overrides,
  };
}

function textUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 999, type: "private" },
      from: { id: 111, is_bot: false, first_name: "A" },
      text,
    },
  };
}

function photoUpdate(): TelegramUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 999, type: "private" },
      from: { id: 111, is_bot: false, first_name: "A" },
      photo: [
        { file_id: "ph1-s", file_unique_id: "ph1-s", width: 100, height: 100, file_size: 10 },
        { file_id: "ph1-l", file_unique_id: "ph1-l", width: 1000, height: 1000, file_size: 500 },
      ],
    },
  };
}

function editAccountCallback(): TelegramUpdate {
  return {
    update_id: 3,
    callback_query: {
      id: "cb-1",
      from: { id: 111, is_bot: false, first_name: "A" },
      chat_instance: "ci-1",
      data: "ea",
      message: {
        message_id: 20,
        date: 1_700_000_000,
        chat: { id: 999, type: "private" },
        from: { id: 1, is_bot: true, first_name: "Bot" },
      },
    },
  };
}

describe("handleUpdate — no accounts guard", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockClearSession.mockReset();
    mockUpsertSession.mockReset();
  });

  it("short-circuits the text/NLU path when the user has zero accounts", async () => {
    const { client, sent } = buildClient();
    mockGetSession.mockResolvedValue(null);
    const deps = buildDeps({ listAccounts: async () => [] });

    await handleUpdate(textUpdate("compré un iPhone por 20k"), client, deps);

    // No account keyboard shown; guard message sent; session cleared.
    const lastSent = sent.at(-1);
    expect(lastSent?.text).toMatch(/No tenés cuentas|no tenés cuentas/i);
    expect(lastSent?.reply_markup).toBeUndefined();
    expect(mockClearSession).toHaveBeenCalledWith(999);
    // The guard fires BEFORE we try to stash the awaiting_account state.
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it("short-circuits the photo path when the user has zero accounts", async () => {
    const { client, sent } = buildClient();
    mockGetSession.mockResolvedValue(null);
    const deps = buildDeps({ listAccounts: async () => [] });

    await handleUpdate(photoUpdate(), client, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/No tenés cuentas|no tenés cuentas/i);
    expect(sent[0].reply_markup).toBeUndefined();
    expect(mockClearSession).toHaveBeenCalledWith(999);
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });

  it("short-circuits EDIT_ACCOUNT callback when accounts is empty", async () => {
    const { client, sent } = buildClient();
    mockGetSession.mockResolvedValue({
      step: "awaiting_confirm",
      draft: {
        amountCents: "4500000",
        currency: "COP",
        direction: "expense",
        accountId: 42,
      },
      sourceChatId: 999,
      sourceMessageId: 10,
    });
    const deps = buildDeps({ listAccounts: async () => [] });

    await handleUpdate(editAccountCallback(), client, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/No tenés cuentas|no tenés cuentas/i);
    expect(sent[0].reply_markup).toBeUndefined();
    expect(mockClearSession).toHaveBeenCalledWith(999);
    expect(mockUpsertSession).not.toHaveBeenCalled();
  });
});
