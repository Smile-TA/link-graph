import { describe, expect, it } from "vitest";
import { redisConnection } from "./queues.js";

describe("redisConnection", () => {
  it("disables BullMQ's request cap, which otherwise abandons a job mid-retry on a blip", () => {
    expect(redisConnection("redis://localhost:6379")).toEqual({
      url: "redis://localhost:6379",
      maxRetriesPerRequest: null,
    });
  });
});
