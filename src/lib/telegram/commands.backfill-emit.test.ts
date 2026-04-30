import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import type { TelegramSessionState } from "@/lib/db/schema";
import { handleUpdate, type RouterDeps } from "./router";

// Hoisted mocks — factories inside vi.mock() are hoisted above top-level consts.
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn(),
  backfillBancolombia: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  clearSession: vi.fn(),
  loadPendingAmbiguousReceipt: vi.fn(),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

vi.mock("@/lib/gmail/backfill", () => ({
  backfillBancolombia: mocks.backfillBancolombia,
  backfillBancolombiaDryRun: vi.fn(),
  BackfillConnectionError: class BackfillConnectionError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
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

vi.mock("@/lib/telegram/disambiguation-query", () => ({
  loadPendingAmbiguousReceipt: mocks.loadPendingAmbiguousReceipt,
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

const FROM_ISO = "2025-01-01T00:00:00.000Z";
const TO_ISO = "2025-12-31T23:59:59.999Z";

function backfillSession(): TelegramSessionState {
  return {
    step: "awaiting_backfill_confirm",
    draft: {},
    sourceChatId: 100,
    backfill: {
      from: FROM_ISO,
      to: TO_ISO,
      gateway: "bancolombia",
    },
  };
}

describe("gmail_backfill_complete emitter — /si confirm flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitNotification.mockResolvedValue({ id: 1 });
    mocks.upsertSession.mockResolvedValue(undefined);
    mocks.clearSession.mockResolvedValue(undefined);
    mocks.loadPendingAmbiguousReceipt.mockResolvedValue(null);
  });

  it("emits gmail_backfill_complete with correct payload on success (no errors)", async () => {
    mocks.getSession
      .mockResolvedValueOnce(backfillSession()) // first call in handleBackfillConfirm
      .mockResolvedValue(null); // shouldCancel polls
    mocks.backfillBancolombia.mockResolvedValue({
      totalEmails: 10,
      alreadyStored: 5,
      parsed: 8,
      skipped: 2,
      needsReview: 0,
      inserted: 3,
      matchedExisting: 0,
      sourceMismatches: 0,
      errors: [],
      durationMs: 1234,
      canceled: false,
    });

    const { client } = buildClient();
    await handleUpdate(textUpdate("/si"), client, buildDeps());

    // Allow the fire-and-forget promise to settle
    await Promise.resolve();

    expect(mocks.emitNotification).toHaveBeenCalledTimes(1);
    expect(mocks.emitNotification).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "gmail_backfill_complete",
        entityId: `backfill-42-${FROM_ISO}-${TO_ISO}`,
        priority: "low",
        title: "Backfill Bancolombia completado",
        body: "Procesamos 10 email(s). Insertamos 3 nuevo(s).",
        actionUrl: "/transactions",
        metadata: expect.objectContaining({
          totalEmails: 10,
          inserted: 3,
          parsed: 8,
          errorCount: 0,
          fromISO: FROM_ISO,
          toISO: TO_ISO,
        }),
      }),
    );
  });

  it("emits body with error count when report.errors is non-empty", async () => {
    mocks.getSession.mockResolvedValueOnce(backfillSession()).mockResolvedValue(null);
    mocks.backfillBancolombia.mockResolvedValue({
      totalEmails: 10,
      alreadyStored: 0,
      parsed: 7,
      skipped: 1,
      needsReview: 0,
      inserted: 6,
      matchedExisting: 0,
      sourceMismatches: 0,
      errors: [{ phase: "get", messageId: "abc", message: "timeout" }],
      durationMs: 800,
      canceled: false,
    });

    const { client } = buildClient();
    await handleUpdate(textUpdate("/si"), client, buildDeps());

    await Promise.resolve();

    expect(mocks.emitNotification).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.emitNotification.mock.calls[0] as [
      number,
      { body: string; metadata: { errorCount: number } },
    ];
    expect(payload.body).toBe("Procesamos 10 email(s). Insertamos 6, con 1 error(es).");
    expect(payload.metadata.errorCount).toBe(1);
  });

  it("does NOT emit when report.canceled is true", async () => {
    mocks.getSession.mockResolvedValueOnce(backfillSession()).mockResolvedValue(null);
    mocks.backfillBancolombia.mockResolvedValue({
      totalEmails: 0,
      alreadyStored: 0,
      parsed: 0,
      skipped: 0,
      needsReview: 0,
      inserted: 0,
      matchedExisting: 0,
      sourceMismatches: 0,
      errors: [],
      durationMs: 100,
      canceled: true,
    });

    const { client } = buildClient();
    await handleUpdate(textUpdate("/si"), client, buildDeps());

    await Promise.resolve();

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});
