import { describe, expect, it } from "vitest";
import { creationRequestHash, restIdempotencyKey } from "./creation-request";
import { createItemInput } from "@/lib/mcp/schemas";
import { createRestItemInput } from "@/lib/api/schemas";

const command = { backlog: "TEST", type: "composant", title: "Root" };
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("creation request identity", () => {
  it("hashes validated fields independently of key order, labels order/duplicates and the key", () => {
    expect(creationRequestHash({ ...command, labelIds: [b, a, a], idempotencyKey: "first" }))
      .toBe(creationRequestHash({ title: "Root", type: "composant", backlog: "TEST", labelIds: [a, b], idempotencyKey: "second" }));
    expect(creationRequestHash(command)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("distinguishes omitted fields from explicit defaults and different content", () => {
    for (const fields of [{ priority: 0 }, { kind: "feature" }, { labelIds: [] }, { title: "Changed" }]) {
      expect(creationRequestHash({ ...command, ...fields })).not.toBe(creationRequestHash(command));
    }
  });
  it("shares the validated REST/MCP fingerprint before reference resolution", () => {
    const { backlogKey, ...rest } = createRestItemInput.parse({ backlogKey: "test", type: "composant", title: " Root ", labelIds: [b.toUpperCase(), a, a] });
    const mcp = createItemInput.parse({ backlog: "TEST", type: "composant", title: "Root", labelIds: [a, b] });
    expect(creationRequestHash({ backlog: backlogKey, ...rest })).toBe(creationRequestHash(mcp));
  });
  it("rejects unknown creation fields instead of silently dropping them", () => {
    expect(createItemInput.safeParse({ ...command, unsupported: "value" }).success).toBe(false);
  });
  it("does not insert transport defaults before hashing", () => {
    expect(createItemInput.parse(command)).toEqual(command);
    expect(createRestItemInput.parse({ backlogKey: "TEST", type: "composant", title: "Root" }))
      .toEqual({ backlogKey: "TEST", type: "composant", title: "Root" });
  });
  it("accepts opaque case-sensitive keys of 1 to 128 characters without trimming", () => {
    for (const key of [" ", "CaseSensitive", "x".repeat(128)]) {
      expect(createItemInput.parse({ ...command, idempotencyKey: key }).idempotencyKey).toBe(key);
    }
    for (const key of ["", "x".repeat(129), 123, null]) {
      expect(createItemInput.safeParse({ ...command, idempotencyKey: key }).success).toBe(false);
    }
  });
  it("merges the header and body and rejects conflicting or invalid headers", () => {
    expect(restIdempotencyKey(null, undefined)).toBeUndefined();
    expect(restIdempotencyKey("Key", undefined)).toBe("Key");
    expect(restIdempotencyKey(null, "Key")).toBe("Key");
    expect(restIdempotencyKey("Key", "Key")).toBe("Key");
    expect(() => restIdempotencyKey("Key", "key")).toThrow();
    for (const key of ["", "x".repeat(129)]) expect(() => restIdempotencyKey(key, undefined)).toThrow();
  });
});
