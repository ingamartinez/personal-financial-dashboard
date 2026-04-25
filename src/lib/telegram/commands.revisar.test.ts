import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import type { TelegramSessionState } from "@/lib/db/schema";
import type { PendingAmbiguousReceipt } from "./disambiguation-query";
import { handleUpdate, type RouterDeps } from "./router";

// Mock disambiguation-query and session to avoid DB deps.
const mocks = vi.hoisted(() => ({
  loadPendingAmbiguousReceipt: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("@/lib/telegram/disambiguation-query", () => ({
  loadPendingAmbiguousReceipt: mocks.loadPendingAmbiguousReceipt,
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

type SentMessage = { chat_id: number; text: string; parse_mode?: string };

function buildClient(): { client: TelegramClient; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (opts) => {
      sent.push({ chat_id: opts.chat_id, text: opts.text, parse_mode: opts.parse_mode });
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

function buildDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    userId: 1,
    listAccounts: async () => [],
    listCategories: async () => [],
    parseNlu: async () => {
      throw new Error("NLU not expected");
    },
    runOcr: async () => {
      throw new Error("OCR not expected");
    },
    transcribeVoice: async () => {
      throw new Error("STT not expected");
    },
    ...overrides,
  };
}

function textUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: 100, type: "private" },
      from: { id: 999, is_bot: false, first_name: "User" },
      text,
    },
  };
}

const fakePending = (): PendingAmbiguousReceipt => ({
  receipt: { id: 7, merchant: "Spotify", occurredAt: new Date("2026-01-15") },
  candidates: [
    {
      id: 1,
      occurredAt: new Date("2026-01-14"),
      amountCents: BigInt(1990000),
      currency: "COP",
      descriptionRaw: "SPOTIFY PREMIUM",
      accountLabel: "Bancolombia · Visa *1234 (COP)",
    },
    {
      id: 2,
      occurredAt: new Date("2026-01-15"),
      amountCents: BigInt(1990000),
      currency: "COP",
      descriptionRaw: "SPOTIFY.COM",
      accountLabel: "Davivienda · Mastercard *5678 (COP)",
    },
  ],
});

describe("/revisar command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
    mocks.loadPendingAmbiguousReceipt.mockResolvedValue(null);
    mocks.upsertSession.mockResolvedValue(undefined);
    mocks.clearSession.mockResolvedValue(undefined);
  });

  it("sends empty message when no pending receipts", async () => {
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("/revisar"), client, buildDeps());
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/No tenés transacciones ambiguas/);
  });

  it("opens a disambiguation session for the oldest pending receipt", async () => {
    mocks.loadPendingAmbiguousReceipt.mockResolvedValueOnce(fakePending());
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("/revisar"), client, buildDeps());
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/Spotify/);
    expect(sent[0].text).toMatch(/1\./);
    expect(sent[0].text).toMatch(/2\./);
    expect(mocks.upsertSession).toHaveBeenCalledOnce();
    const call = mocks.upsertSession.mock.calls[0][0] as {
      state: TelegramSessionState;
    };
    expect(call.state.step).toBe("awaiting_disambiguation");
    expect(call.state.disambiguationReceiptId).toBe(7);
  });

  it("tells the user when a disambiguation session is already open", async () => {
    const session: TelegramSessionState = {
      step: "awaiting_disambiguation",
      draft: {},
      sourceChatId: 100,
      disambiguationReceiptId: 7,
      disambiguationCandidates: [1, 2],
    };
    mocks.getSession.mockResolvedValueOnce(session);
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("/revisar"), client, buildDeps());
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/pendiente|abierta/i);
    expect(mocks.upsertSession).not.toHaveBeenCalled();
  });
});
