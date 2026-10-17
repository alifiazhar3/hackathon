import { describe, expect, it } from "vitest";
import { bottleGroups, groupLabel } from "@/lib/bottles";

const summary = (n: number) => bottleGroups(n).map((g) => [g.size, g.fills.length, g.fills[g.fills.length - 1]]);

describe("bottle sizes", () => {
  it("splits into place values, biggest first", () => {
    expect(summary(13_855)).toEqual([
      [10_000, 1, 1],
      [1_000, 3, 1],
      [100, 8, 1],
      [10, 5, 1],
      [1, 5, 1],
    ]);
  });

  it("adds a partly filled normal bottle for the remainder", () => {
    const groups = bottleGroups(23.4);
    expect(groups.map((g) => g.size)).toEqual([10, 1]);
    expect(groups[1].fills).toHaveLength(4);
    expect(groups[1].fills[3]).toBeCloseTo(0.4);
  });

  it("shows a single part-filled bottle for less than one", () => {
    const groups = bottleGroups(0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0].fills[0]).toBeCloseTo(0.3);
    expect(groupLabel(groups[0])).toBe("part of a bottle");
  });

  it("stacks more than nine of the biggest size", () => {
    expect(bottleGroups(2_300_000)[0]).toMatchObject({ size: 100_000 });
    expect(bottleGroups(2_300_000)[0].fills).toHaveLength(23);
  });
});
