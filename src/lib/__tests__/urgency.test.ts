import { describe, expect, it } from "vitest";
import { breakEvenDays, costOfWaiting, MAX_GROWTH, rateMultiplier, urgency } from "@/lib/urgency";

describe("urgency model", () => {
  it("the drip worsens about 5% a month, up to 5x", () => {
    expect(rateMultiplier(0)).toBe(1);
    expect(rateMultiplier(30.44)).toBeCloseTo(1.05);
    expect(rateMultiplier(365)).toBeCloseTo(1.05 ** 12, 2);
    expect(rateMultiplier(3650)).toBe(MAX_GROWTH);
  });

  it("waiting costs more than today's rate times the days", () => {
    const flat = 0.1 * 365;
    const worsening = costOfWaiting(0.1, 365);
    expect(worsening).toBeGreaterThan(flat);
    // average rate over a year is about 1.37x at 5% a month
    expect(worsening / flat).toBeGreaterThan(1.3);
    expect(worsening / flat).toBeLessThan(1.45);
    expect(costOfWaiting(0.1, 0)).toBe(0);
    // with no growth it's exactly the flat cost
    expect(costOfWaiting(0.1, 365, 0)).toBeCloseTo(flat, 6);
  });

  it("break-even comes sooner when the drip worsens", () => {
    const flat = breakEvenDays(0.05, 15, 0);
    expect(flat).toBeCloseTo(300, 0);
    expect(breakEvenDays(0.05, 15)).toBeLessThan(flat);
    expect(breakEvenDays(0, 15)).toBe(Infinity);
    expect(breakEvenDays(0.05, 0)).toBe(0);
  });

  it("hidden leaks are always urgent", () => {
    expect(urgency({ dropsPerMin: 5, location: "hidden", breakEven: 2000, stream: false }).level).toBe("now");
    expect(urgency({ dropsPerMin: 5, location: "wall", breakEven: 2000, stream: false }).level).toBe("now");
  });

  it("over a sink, urgency follows speed and break-even", () => {
    expect(urgency({ dropsPerMin: 150, location: "sink", breakEven: 2000, stream: false }).level).toBe("now");
    expect(urgency({ dropsPerMin: 60, location: "sink", breakEven: 60, stream: false }).level).toBe("now");
    expect(urgency({ dropsPerMin: 60, location: "sink", breakEven: 200, stream: false }).level).toBe("month");
    expect(urgency({ dropsPerMin: 5, location: "sink", breakEven: 900, stream: false }).level).toBe("soon");
    expect(urgency({ dropsPerMin: 5, location: "sink", breakEven: 900, stream: true }).level).toBe("now");
  });
});
