import { describe, expect, it } from "vitest";
import { redisConnection, redisUrl } from "./queues.js";

describe("redisConnection", () => {
  it("disables BullMQ's request cap, which otherwise abandons a job mid-retry on a blip", () => {
    expect(redisConnection("redis://localhost:6379")).toEqual({
      url: "redis://localhost:6379",
      maxRetriesPerRequest: null,
    });
  });
});

describe("redisUrl", () => {
  it("falls back to the local compose service when unset", () => {
    expect(redisUrl({})).toBe("redis://localhost:6379");
  });

  it("falls back on an empty string too — what an unset variable looks like in Compose", () => {
    expect(redisUrl({ REDIS_URL: "" })).toBe("redis://localhost:6379");
  });

  it("uses REDIS_URL when set", () => {
    expect(redisUrl({ REDIS_URL: "redis://redis:6379" })).toBe("redis://redis:6379");
  });
});
