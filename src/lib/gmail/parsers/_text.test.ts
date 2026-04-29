import { describe, expect, it } from "vitest";
import { extractVisibleText } from "./_text";

// ---------------------------------------------------------------------------
// extractVisibleText — entity decoding tests
//
// The main risk area documented in _text.ts is CodeQL js/double-escaping:
//   - NAMED_ENTITIES uses a single-pass atomic replacer, so no entity
//     replacement can cascade through another.
//   - "amp" lives only in the lookup table, never as a standalone .replace() call.
//
// These tests cover entities that were missing before issue #641 and verify
// the no-cascade guarantee for the amp+rsquo combination.
// ---------------------------------------------------------------------------

describe("extractVisibleText — smart quotes and ellipsis (issue #641)", () => {
  it("decodes &rsquo; to right single quotation mark", () => {
    // ARQ emails use "We&rsquo;ve debited" — this was the root cause of #641.
    expect(extractVisibleText("We&rsquo;ve debited 334.64 USDc")).toBe(
      "We’ve debited 334.64 USDc",
    );
  });

  it("decodes &lsquo; to left single quotation mark", () => {
    expect(extractVisibleText("&lsquo;Hello&rsquo;")).toBe("‘Hello’");
  });

  it("decodes &rdquo; to right double quotation mark", () => {
    expect(extractVisibleText("She said &rdquo;done&rdquo;")).toBe(
      "She said ”done”",
    );
  });

  it("decodes &ldquo; to left double quotation mark", () => {
    expect(extractVisibleText("&ldquo;Quoted&rdquo;")).toBe("“Quoted”");
  });

  it("decodes &hellip; to horizontal ellipsis", () => {
    expect(extractVisibleText("Loading&hellip;")).toBe("Loading…");
  });
});

describe("extractVisibleText — no double-decoding (CodeQL js/double-escaping regression)", () => {
  it("does not double-decode &amp;rsquo; (escaped smart quote)", () => {
    // "&amp;rsquo;" should become "&rsquo;" (just amp decoded), NOT "'" (double-decode).
    // The single-pass atomic replacer ensures amp is replaced in one pass and the
    // resulting "&rsquo;" is never re-scanned.
    expect(extractVisibleText("&amp;rsquo;")).toBe("&rsquo;");
  });

  it("does not double-decode &amp;amp; (escaped ampersand)", () => {
    // "&amp;amp;" → "&amp;" (one pass), NOT "&" (double-decode).
    expect(extractVisibleText("&amp;amp;")).toBe("&amp;");
  });

  it("mixes &amp; and &rsquo; in the same string without cascade", () => {
    // Combines both entities in one string to confirm neither cascades through the other.
    // "Johnson &amp; Johnson&rsquo;s product" → "Johnson & Johnson’s product"
    expect(extractVisibleText("Johnson &amp; Johnson&rsquo;s product")).toBe(
      "Johnson & Johnson’s product",
    );
  });
});

describe("extractVisibleText — pre-existing entities (regression guard)", () => {
  it("decodes &nbsp; to space", () => {
    expect(extractVisibleText("hello&nbsp;world")).toBe("hello world");
  });

  it("decodes &amp; to ampersand", () => {
    expect(extractVisibleText("a &amp; b")).toBe("a & b");
  });

  it("decodes Spanish accents", () => {
    expect(extractVisibleText("&ntilde;&uacute;mero")).toBe("ñúmero");
  });

  it("strips HTML tags and collapses whitespace", () => {
    expect(extractVisibleText("<p>Hello   <strong>world</strong></p>")).toBe("Hello world");
  });

  it("strips style blocks before decoding entities", () => {
    const html = `<style>.x::before { content: "We&rsquo;ve loaded"; }</style><p>Done</p>`;
    // The entity inside <style> must NOT appear in output.
    expect(extractVisibleText(html)).toBe("Done");
  });
});
