import { describe, expect, it } from "vitest";
import { lengthProblem, MAX_SECONDS, MIN_SECONDS } from "@/lib/recorder";

describe("recording length", () => {
  it("accepts 10 to 30 seconds", () => {
    expect(MIN_SECONDS).toBe(10);
    expect(MAX_SECONDS).toBe(30);
    for (const s of [10, 11.6, 20, 30, 30.4]) expect(lengthProblem(s, "video")).toBeNull();
  });

  it("rejects clips that are too short or too long", () => {
    expect(lengthProblem(4.2, "recording")).toBe("this recording is only 4.2 seconds long");
    expect(lengthProblem(9.9, "video")).toBe("this video is only 9.9 seconds long");
    expect(lengthProblem(45, "video")).toBe("this video is 45 seconds long, more than 30");
  });

  it("rejects clips whose length can't be read", () => {
    expect(lengthProblem(Infinity, "video")).toMatch(/couldn't tell/);
    expect(lengthProblem(NaN, "recording")).toMatch(/couldn't tell/);
  });
});
