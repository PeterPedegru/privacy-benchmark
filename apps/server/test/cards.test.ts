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

describe("favicons on cards", () => {
  /** A one-image .ico holding a w×h 32-bit bitmap where every pixel is the given BGRA colour. */
  function ico(w: number, h: number, bgra: [number, number, number, number]): Buffer {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(w, 4);
    header.writeInt32LE(h * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) pixels.set(bgra, i * 4);
    const mask = Buffer.alloc(Math.ceil(w / 32) * 4 * h);
    const image = Buffer.concat([header, pixels, mask]);
    const dir = Buffer.alloc(22);
    dir.writeUInt16LE(1, 2);
    dir.writeUInt16LE(1, 4);
    dir[6] = w;
    dir[7] = h;
    dir.writeUInt16LE(32, 12);
    dir.writeUInt32LE(image.length, 14);
    dir.writeUInt32LE(22, 18);
    return Buffer.concat([dir, image]);
  }

  it("become PNGs of their largest image, colours and size kept", async () => {
    const { icoToPng } = await import("../src/lib/ico.ts");
    const png = icoToPng(ico(4, 3, [0x30, 0x20, 0x10, 0xff]))!;
    expect(png.readUInt32BE(0)).toBe(0x89504e47);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([4, 3]);
    const { inflateSync } = await import("node:zlib");
    const idat = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    // Filter byte, then RGBA: the bitmap's BGRA reordered.
    expect([...raw.subarray(0, 5)]).toEqual([0, 0x10, 0x20, 0x30, 0xff]);
  });

  it("refuse what they can't read", async () => {
    const { icoToPng } = await import("../src/lib/ico.ts");
    expect(icoToPng(Buffer.from("not an icon"))).toBeNull();
  });
});
