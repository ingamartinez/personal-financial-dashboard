import { describe, expect, it } from "vitest";
import {
  AMOUNT_TOLERANCE_BPS,
  isWithinAmountTolerance,
  pickTxForRecurring,
  scoreMatchCandidates,
  type MatchCandidate,
  type MatchTx,
  type RecurringQuery,
  type TxCandidate,
} from "./match-score";

function tx(overrides: Partial<MatchTx> & { descriptionRaw: string | null }): MatchTx {
  return {
    amountCents: BigInt(-4490000),
    currency: "COP",
    accountId: 1,
    ...overrides,
  };
}

function candidate(overrides: Partial<MatchCandidate> & { recurringId: number }): MatchCandidate {
  return {
    accountId: 1,
    amountCents: BigInt(-4490000),
    currency: "COP",
    patterns: [],
    ...overrides,
  };
}

describe("scoreMatchCandidates", () => {
  it("returns no winner when there are no candidates", () => {
    const result = scoreMatchCandidates(tx({ descriptionRaw: "NETFLIX" }), []);
    expect(result).toEqual({ winner: null, ambiguous: false });
  });

  // ---------------------------------------------------------------------
  // Real prod scenario: four recurrings share exactly -4490000 COP.
  // Apple iCloud, ML 6 Disney+, Netflix, Google One — four DISTINCT tokens
  // must separate them even though amount alone cannot.
  // ---------------------------------------------------------------------
  describe("four-way -4490000 COP collision — distinct tokens separate them", () => {
    const appleICloud = candidate({ recurringId: 1, accountId: 10, patterns: ["APPLE"] });
    const ml6Disney = candidate({ recurringId: 2, accountId: 10, patterns: ["MERCADO"] });
    const netflix = candidate({ recurringId: 3, accountId: 10, patterns: ["NETFLIX"] });
    const googleOne = candidate({ recurringId: 4, accountId: 10, patterns: ["GOOGLE", "DLO"] });
    const allFour = [appleICloud, ml6Disney, netflix, googleOne];

    it("NETFLIX description links to Netflix", () => {
      const result = scoreMatchCandidates(tx({ descriptionRaw: "NETFLIX" }), allFour);
      expect(result.ambiguous).toBe(false);
      expect(result.winner?.recurringId).toBe(3);
      expect(result.winner?.reason).toBe("token");
    });

    it("APPLE.COM/BILL links to Apple iCloud", () => {
      const result = scoreMatchCandidates(tx({ descriptionRaw: "APPLE.COM/BILL" }), allFour);
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.reason).toBe("token");
    });

    it("MERCADO PAGO*MELIMAS links to ML 6 Disney+", () => {
      const result = scoreMatchCandidates(tx({ descriptionRaw: "MERCADO PAGO*MELIMAS" }), allFour);
      expect(result.winner?.recurringId).toBe(2);
    });

    it("GOOGLE *Google One links to Google One via the GOOGLE token", () => {
      const result = scoreMatchCandidates(tx({ descriptionRaw: "GOOGLE *Google One" }), allFour);
      expect(result.winner?.recurringId).toBe(4);
      expect(result.winner?.reason).toBe("token");
    });

    it("DLO*GOOGLE Google On links to Google One via its SECOND token (pattern union)", () => {
      // Google One legitimately produces two tokens from two different
      // description shapes — the recurring's patterns must be the union.
      const result = scoreMatchCandidates(tx({ descriptionRaw: "DLO*GOOGLE Google On" }), allFour);
      expect(result.winner?.recurringId).toBe(4);
      expect(result.winner?.reason).toBe("token");
    });
  });

  // ---------------------------------------------------------------------
  // Real prod scenario: token collides, amount separates.
  // ---------------------------------------------------------------------
  describe("APPLE.COM/BILL at two amounts — amount disambiguates the token collision", () => {
    const appleICloud = candidate({
      recurringId: 1,
      accountId: 10,
      amountCents: BigInt(-4490000),
      patterns: ["APPLE"],
    });
    const appleTV = candidate({
      recurringId: 2,
      accountId: 20,
      amountCents: BigInt(-2990000),
      patterns: ["APPLE"],
    });
    const both = [appleICloud, appleTV];

    it("payment of -4490000 links to Apple iCloud", () => {
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-4490000), accountId: 10 }),
        both,
      );
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.reason).toBe("token+amount-exact");
    });

    it("payment of -2990000 links to Apple TV", () => {
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-2990000), accountId: 20 }),
        both,
      );
      expect(result.winner?.recurringId).toBe(2);
      expect(result.winner?.reason).toBe("token+amount-exact");
    });

    it("payment of an amount matching NEITHER exactly falls back to nearest amount", () => {
      // -3500000 is closer to Apple TV's -2990000 (510000 away) than to
      // Apple iCloud's -4490000 (990000 away).
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-3500000), accountId: 20 }),
        both,
      );
      expect(result.winner?.recurringId).toBe(2);
      expect(result.winner?.reason).toBe("token+amount-nearest");
    });
  });

  describe("GOOGLE * at two amounts — amount disambiguates", () => {
    const googleOne = candidate({
      recurringId: 4,
      accountId: 10,
      amountCents: BigInt(-4490000),
      patterns: ["GOOGLE", "DLO"],
    });
    const crunchyroll = candidate({
      recurringId: 5,
      accountId: 10,
      amountCents: BigInt(-1990000),
      patterns: ["GOOGLE"],
    });
    const both = [googleOne, crunchyroll];

    it("-4490000 links to Google One", () => {
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "GOOGLE *Google One", amountCents: BigInt(-4490000) }),
        both,
      );
      expect(result.winner?.recurringId).toBe(4);
    });

    it("-1990000 links to Crunchyroll", () => {
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "GOOGLE *Crunchyroll", amountCents: BigInt(-1990000) }),
        both,
      );
      expect(result.winner?.recurringId).toBe(5);
    });
  });

  // ---------------------------------------------------------------------
  // False-positive guards — amount-only matching must NOT fire when a
  // usable-but-unmatched token is present.
  // ---------------------------------------------------------------------
  describe("false-positive guards (real prod counter-examples)", () => {
    const appleTV = candidate({
      recurringId: 2,
      accountId: 20,
      amountCents: BigInt(-2990000),
      patterns: ["APPLE"],
    });
    const smartFit = candidate({
      recurringId: 6,
      accountId: 30,
      amountCents: BigInt(-10990000),
      patterns: ["SMARTFIT"],
    });

    it("KFC purchase byte-identical to Apple TV's amount does NOT auto-link", () => {
      const result = scoreMatchCandidates(
        tx({
          descriptionRaw: "KFC UNICENTRO MEDELL",
          amountCents: BigInt(-2990000),
          accountId: 20,
        }),
        [appleTV],
      );
      expect(result.winner).toBeNull();
      expect(result.ambiguous).toBe(false);
    });

    it("SPORTY CITY gym purchase byte-identical to SmartFit's amount does NOT auto-link", () => {
      const result = scoreMatchCandidates(
        tx({
          descriptionRaw: "SPORTY CITY SAS7888",
          amountCents: BigInt(-10990000),
          accountId: 30,
        }),
        [smartFit],
      );
      expect(result.winner).toBeNull();
    });

    it("bank transfer byte-identical to SmartFit's amount does NOT auto-link", () => {
      const result = scoreMatchCandidates(
        tx({
          descriptionRaw: "Transferencia a cuenta *3187356871",
          amountCents: BigInt(-10990000),
          accountId: 30,
        }),
        [smartFit],
      );
      expect(result.winner).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Amount-only fallback — only legitimate when the token is absent.
  // ---------------------------------------------------------------------
  describe("amount-only fallback", () => {
    it("links when the description has no usable token and amount is unique", () => {
      const c = candidate({ recurringId: 1, patterns: [] });
      const result = scoreMatchCandidates(tx({ descriptionRaw: "1234 5678" }), [c]);
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.reason).toBe("amount-only");
    });

    it("null/empty description also uses amount-only", () => {
      const c = candidate({ recurringId: 1, patterns: [] });
      const result = scoreMatchCandidates(tx({ descriptionRaw: null }), [c]);
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.reason).toBe("amount-only");
    });

    it("does NOT link when 2+ candidates share the amount and there is no token", () => {
      const a = candidate({ recurringId: 1, patterns: [] });
      const b = candidate({ recurringId: 2, patterns: [] });
      const result = scoreMatchCandidates(tx({ descriptionRaw: null }), [a, b]);
      expect(result.winner).toBeNull();
      expect(result.ambiguous).toBe(true);
    });

    it("does not match a different currency even with the same numeric amount", () => {
      const c = candidate({ recurringId: 1, currency: "USD", patterns: [] });
      const result = scoreMatchCandidates(tx({ descriptionRaw: null, currency: "COP" }), [c]);
      expect(result.winner).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Same-account is a ranking bonus / tie-breaker, never a hard predicate.
  // ---------------------------------------------------------------------
  describe("same-account as tie-breaker only", () => {
    it("cross-account token match still wins (account is not a hard predicate)", () => {
      const c = candidate({ recurringId: 1, accountId: 99, patterns: ["NETFLIX"] });
      const result = scoreMatchCandidates(tx({ descriptionRaw: "NETFLIX", accountId: 1 }), [c]);
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.sameAccount).toBe(false);
    });

    it("breaks a token+exact-amount tie using the matching account", () => {
      const same = candidate({ recurringId: 1, accountId: 5, patterns: ["GOOGLE"] });
      const other = candidate({ recurringId: 2, accountId: 9, patterns: ["GOOGLE"] });
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "GOOGLE *Something", accountId: 5 }),
        [same, other],
      );
      expect(result.winner?.recurringId).toBe(1);
      expect(result.winner?.sameAccount).toBe(true);
    });

    it("stays ambiguous when the account tie-break itself is ambiguous (both same account)", () => {
      const a = candidate({ recurringId: 1, accountId: 5, patterns: ["GOOGLE"] });
      const b = candidate({ recurringId: 2, accountId: 5, patterns: ["GOOGLE"] });
      const result = scoreMatchCandidates(
        tx({ descriptionRaw: "GOOGLE *Something", accountId: 5 }),
        [a, b],
      );
      expect(result.winner).toBeNull();
      expect(result.ambiguous).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // #857: bounded leftover tolerance when a shared token collides.
  // ---------------------------------------------------------------------
  describe("#857 bounded amount tolerance when tokens collide", () => {
    // Prod Aida / Alejo amounts. Token "PAGO" is what tokeniseDescription
    // extracts from "Pago a APORTES EN LINEA".
    const aida = (recurringId: number) =>
      candidate({
        recurringId,
        accountId: 1,
        amountCents: BigInt(-49910000),
        patterns: ["PAGO"],
      });
    const alejo = (recurringId: number) =>
      candidate({
        recurringId,
        accountId: 1,
        amountCents: BigInt(-50830000),
        patterns: ["PAGO"],
      });

    it("unique in-tolerance leftover wins even when that recurring has the higher id", () => {
      // Alejo is first in the array AND has the lower id. Aida is the unique
      // candidate inside 1% of tx 2460's -50_110_000. If lowest-id or array
      // order carried this, Alejo would win.
      const result = scoreMatchCandidates(
        tx({
          descriptionRaw: "Pago a APORTES EN LINEA",
          amountCents: BigInt(-50110000),
          accountId: 1,
        }),
        [alejo(1), aida(99)],
      );
      expect(result.winner?.recurringId).toBe(99);
      expect(result.ambiguous).toBe(false);
    });

    it("a tx within 1% of two still-available recurrings abstains — neither lowest-id nor nearest", () => {
      // -50_350_000 is 0.88% from Aida and 0.94% from Alejo — both inside
      // 1%. Lowest-id and nearest both pick Aida (id 1, slightly closer).
      // Ambiguity must abstain anyway.
      const result = scoreMatchCandidates(
        tx({
          descriptionRaw: "Pago a APORTES EN LINEA",
          amountCents: BigInt(-50350000),
          accountId: 1,
        }),
        [aida(1), alejo(99)],
      );
      expect(result.winner).toBeNull();
      expect(result.ambiguous).toBe(true);
    });
  });
});

describe("isWithinAmountTolerance", () => {
  it("is 1% (100 bps), inclusive at the boundary", () => {
    expect(AMOUNT_TOLERANCE_BPS).toBe(BigInt(100));
    const rec = BigInt(-49910000);
    const onePct = BigInt(499100);
    expect(isWithinAmountTolerance(rec, rec - onePct, "COP", "COP")).toBe(true);
    expect(isWithinAmountTolerance(rec, rec - onePct - BigInt(1), "COP", "COP")).toBe(false);
  });

  it("covers the 0.40% Aida July drift and does not span the 1.84% twin gap", () => {
    const aida = BigInt(-49910000);
    expect(isWithinAmountTolerance(aida, BigInt(-50110000), "COP", "COP")).toBe(true);
    expect(isWithinAmountTolerance(aida, BigInt(-50830000), "COP", "COP")).toBe(false);
  });

  it("rejects a different currency even at distance 0", () => {
    expect(isWithinAmountTolerance(BigInt(-100), BigInt(-100), "COP", "USD")).toBe(false);
  });
});

describe("pickTxForRecurring (inverse direction — used by the gap-closing cron)", () => {
  function recurring(overrides: Partial<RecurringQuery> = {}): RecurringQuery {
    return {
      accountId: 10,
      amountCents: BigInt(-4490000),
      currency: "COP",
      patterns: ["NETFLIX"],
      ...overrides,
    };
  }

  function txCandidate(overrides: Partial<TxCandidate> & { txId: number }): TxCandidate {
    return {
      accountId: 10,
      amountCents: BigInt(-4490000),
      currency: "COP",
      descriptionRaw: "NETFLIX",
      ...overrides,
    };
  }

  it("picks the single tx whose own token matches the recurring's patterns", () => {
    const result = pickTxForRecurring(recurring(), [
      txCandidate({ txId: 1, descriptionRaw: "NETFLIX" }),
      txCandidate({ txId: 2, descriptionRaw: "KFC RESTAURANTE", accountId: 20 }),
    ]);
    expect(result.winner?.txId).toBe(1);
  });

  it("blocks amount-only fallback when a candidate has an extractable-but-unmatched token", () => {
    // Only candidate is the KFC purchase — same amount, unrelated token.
    const result = pickTxForRecurring(recurring({ patterns: ["APPLE"] }), [
      txCandidate({ txId: 1, descriptionRaw: "KFC UNICENTRO MEDELL" }),
    ]);
    expect(result.winner).toBeNull();
  });

  it("falls back to amount-only when the candidate's description has no usable token", () => {
    const result = pickTxForRecurring(recurring({ patterns: ["APPLE"] }), [
      txCandidate({ txId: 1, descriptionRaw: "1234 5678" }),
    ]);
    expect(result.winner?.txId).toBe(1);
  });

  it("disambiguates two token-matching candidates by exact amount", () => {
    const result = pickTxForRecurring(
      recurring({ patterns: ["APPLE"], amountCents: BigInt(-2990000) }),
      [
        txCandidate({ txId: 1, descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-4490000) }),
        txCandidate({ txId: 2, descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-2990000) }),
      ],
    );
    expect(result.winner?.txId).toBe(2);
  });

  it("returns ambiguous when nothing disambiguates two token matches", () => {
    const result = pickTxForRecurring(recurring({ patterns: ["APPLE"] }), [
      txCandidate({ txId: 1, descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-1000) }),
      txCandidate({ txId: 2, descriptionRaw: "APPLE.COM/BILL", amountCents: BigInt(-2000) }),
    ]);
    expect(result.winner).toBeNull();
    expect(result.ambiguous).toBe(true);
  });
});
