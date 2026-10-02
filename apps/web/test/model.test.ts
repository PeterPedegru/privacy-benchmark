import { describe, expect, it } from "vitest";
import { bestIndices } from "../src/components/bench/model";

describe("best-in-row", () => {
  it("highlights the maximum at display precision, including ties", () => {
    expect(bestIndices([68.94, 68.9, 51.3])).toEqual([0, 1]);
    expect(bestIndices([10, 20, 30])).toEqual([2]);
  });
  it("ignores missing values and returns nothing when all are missing", () => {
    expect(bestIndices([null, 12, undefined])).toEqual([1]);
    expect(bestIndices([null, null])).toEqual([]);
  });
});
