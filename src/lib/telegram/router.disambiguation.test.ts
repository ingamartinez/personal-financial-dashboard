import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import type { TelegramSessionState } from "@/lib/db/schema";
import type { PendingAmbiguousReceipt } from "./disambiguation-query";
import { handleUpdate, type RouterDeps } from "./router";

// Hoist shared mock state so factories can reference them.
const mocks = vi.hoisted(() => ({
  applyEnrichment: vi.fn(),
  applyRejection: vi.fn(),
  loadPendingAmbiguousReceipt: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("@/lib/gmail/enrich", () => ({ applyEnrichment: mocks.applyEnrichment }));
vi.mock("@/lib/gmail/disambiguate", () => ({ applyRejection: mocks.applyRejection }));
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
    userId: 42,
    listAccounts: async () => [],
    listCategories: async () => [],
    parseNlu: async () => {
      throw new Error("NLU should not run");
    },
    runOcr: async () => {
      throw new Error("OCR should not run");
    },
    transcribeVoice: async () => {
      throw new Error("STT should not run");
    },
    ...overrides,
  };
}

function textUpdate(text: string, chatId = 200): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: chatId, type: "private" },
      from: { id: 999, is_bot: false, first_name: "User" },
      text,
    },
  };
}

const disambiguationSession = (candidateIds: number[], receiptId = 10): TelegramSessionState => ({
  step: "awaiting_disambiguation",
  draft: {},
  sourceChatId: 200,
  disambiguationReceiptId: receiptId,
  disambiguationCandidates: candidateIds,
});

describe("handleUpdate — disambiguation reply intercept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyEnrichment.mockResolvedValue(undefined);
    mocks.applyRejection.mockResolvedValue({ rejected: 1 });
    mocks.loadPendingAmbiguousReceipt.mockResolvedValue(null);
    mocks.getSession.mockResolvedValue(null);
    mocks.upsertSession.mockResolvedValue(undefined);
    mocks.clearSession.mockResolvedValue(undefined);
  });

  it("calls applyEnrichment when user replies with '1'", async () => {
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([101, 202]));
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("1"), client, buildDeps());
    expect(mocks.applyEnrichment).toHaveBeenCalledWith(42, 101, 10);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/vinculado|#101/);
    expect(mocks.clearSession).toHaveBeenCalledWith(200);
  });

  it("calls applyEnrichment with the second candidate when user replies '2'", async () => {
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([101, 202]));
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("2"), client, buildDeps());
    expect(mocks.applyEnrichment).toHaveBeenCalledWith(42, 202, 10);
    expect(sent[0].text).toMatch(/#202/);
  });

  it("re-prompts when user sends invalid input", async () => {
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([101, 202]));
    // loadPendingAmbiguousReceipt returns null for the reprompt lookup
    mocks.loadPendingAmbiguousReceipt.mockResolvedValueOnce(null);
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("asdf"), client, buildDeps());
    expect(mocks.applyEnrichment).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/No entendí|Respondé/);
  });

  it("does not process disambiguation reply for a different user's receipt (cross-tenant)", async () => {
    // Session exists but applyEnrichment throws cross-tenant
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([999]));
    mocks.applyEnrichment.mockRejectedValueOnce(
      new Error("cross-tenant attempt: transaction does not belong to user"),
    );
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("1"), client, buildDeps({ userId: 42 }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/falló|⚠️/i);
    // Session should be cleared even on cross-tenant error
    expect(mocks.clearSession).toHaveBeenCalled();
  });

  it("rejects other candidates when user confirms one", async () => {
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([101, 202, 303]));
    await handleUpdate(textUpdate("1"), client_noop(), buildDeps());
    // 101 gets enrichment; 202 and 303 get rejected
    expect(mocks.applyEnrichment).toHaveBeenCalledWith(42, 101, 10);
    expect(mocks.applyRejection).toHaveBeenCalledWith(42, 202);
    expect(mocks.applyRejection).toHaveBeenCalledWith(42, 303);
  });

  it("auto-chains to next receipt after resolving one", async () => {
    mocks.getSession.mockResolvedValueOnce(disambiguationSession([101]));
    const nextPending: PendingAmbiguousReceipt = {
      receipt: { id: 20, merchant: "Netflix", occurredAt: new Date("2026-01-16") },
      candidates: [
        {
          id: 500,
          occurredAt: new Date("2026-01-16"),
          amountCents: BigInt(2000000),
          currency: "COP",
          descriptionRaw: "NETFLIX.COM",
          accountLabel: "Visa (COP)",
        },
      ],
    };
    mocks.loadPendingAmbiguousReceipt.mockResolvedValueOnce(nextPending);
    const { client, sent } = buildClient();
    await handleUpdate(textUpdate("1"), client, buildDeps());
    // First message: confirmed; second: next disambiguation prompt
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toMatch(/vinculado/);
    expect(sent[1].text).toMatch(/Netflix|20/);
  });
});

// Minimal no-op client for tests that don't care about sent messages.
function client_noop(): TelegramClient {
  return buildClient().client;
}
