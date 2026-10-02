import { describe, expect, it } from "vitest";
import { fmtNum, fmtPct, safeHref, sourceLink } from "../src/lib/utils";

describe("safeHref", () => {
  it("passes absolute http(s) URLs", () => {
    expect(safeHref("https://docs.aztec.network/security")).toBe("https://docs.aztec.network/security");
    expect(safeHref("http://example.org/a?b=1#c")).toBe("http://example.org/a?b=1#c");
    expect(safeHref("  HTTPS://Example.org/x  ")).toBe("https://example.org/x");
  });

  it("rejects script, data and other schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.org/file",
      "mailto:someone@example.org",
      "blob:https://example.org/uuid",
    ])
      expect(safeHref(bad), bad).toBeNull();
  });

  it("rejects relative, scheme-less and empty input instead of resolving it against the page", () => {
    for (const bad of ["/admin", "//evil.example/x", "example.org", "", "   ", null, undefined]) expect(safeHref(bad), String(bad)).toBeNull();
  });
});

describe("sourceLink", () => {
  it("links onchain reads to a block explorer", () => {
    expect(sourceLink("evm://1/0x0000000000000000000000000000000000000001")).toBe("https://etherscan.io/address/0x0000000000000000000000000000000000000001");
    expect(sourceLink("evm://999/0x0000000000000000000000000000000000000001")).toBeNull();
  });

  it("drops internal notes and unsafe schemes", () => {
    expect(sourceLink("note://editor/123")).toBeNull();
    expect(sourceLink("https://kb.local/doc")).toBeNull();
    expect(sourceLink("javascript:alert(1)")).toBeNull();
    expect(sourceLink("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });
});

describe("number formatting for dense cells", () => {
  it("rounds half up at display precision, matching the animated numbers", () => {
    expect(fmtNum(0.15)).toBe("0.2"); // toFixed(1) would give "0.1"
    expect(fmtNum(68.95)).toBe("69.0");
    expect(fmtNum(68.94)).toBe("68.9");
    expect(fmtNum(100)).toBe("100.0");
    expect(fmtNum(0)).toBe("0.0");
    expect(fmtNum(12.346, 2)).toBe("12.35");
    expect(fmtNum(7, 0)).toBe("7");
  });

  it("never prints negative zero", () => {
    expect(fmtNum(-0.01)).toBe("0.0");
    expect(fmtNum(-0)).toBe("0.0");
  });

  it("shows a dash for missing values", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fmtNum(v)).toBe("—");
      expect(fmtPct(v)).toBe("—");
    }
  });

  it("adds the percent sign", () => {
    expect(fmtPct(73.6)).toBe("73.6%");
    expect(fmtPct(33.333, 0)).toBe("33%");
  });
});
