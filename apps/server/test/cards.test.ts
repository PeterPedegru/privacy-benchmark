/**
 * Share cards draw real letters. Satori shapes text with HarfBuzz, which can't read WOFF: handed one, every character
 * became the font's "NO GLYPH" box, so any two strings of the same length rendered identically.
 */
import satori from "satori";
import { describe, expect, it } from "vitest";
import { FONTS } from "../src/cards/render.tsx";

const svgOf = (text: string) =>
  satori({ type: "div", props: { style: { display: "flex", fontFamily: "Inter", fontSize: 32 }, children: text } } as never, {
    width: 400,
    height: 60,
    fonts: FONTS,
  });

describe("card fonts", () => {
  it("are TrueType, which the text shaper reads", () => {
    for (const f of FONTS) expect(f.data.readUInt32BE(0)).toBe(0x00010000);
  });

  it("draw each character as its own glyph", async () => {
    expect(await svgOf("Privacy")).not.toBe(await svgOf("Zcash42"));
    expect(await svgOf("Privacy")).toBe(await svgOf("Privacy"));
  });
});
