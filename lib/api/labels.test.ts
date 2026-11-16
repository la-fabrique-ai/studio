import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), budget: vi.fn(), backlog: vi.fn(), item: vi.fn(), list: vi.fn(), create: vi.fn(), add: vi.fn(), remove: vi.fn(), createItem: vi.fn(), updateItem: vi.fn(), summary: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/authenticate", () => ({ authenticateBearer: m.auth, bearerChallenge: () => 'Bearer realm="jiroo"' }));
vi.mock("@/lib/api/rate-limit", () => ({ reserveApiRequest: m.budget }));
vi.mock("@/lib/services/api-tokens", () => ({ scopeAllows: (g: string, r: string) => g === "write" || r === "read" }));
vi.mock("@/lib/services/api-read", () => ({ resolveApiBacklog: m.backlog, resolveApiItem: m.item, getApiItemSummary: m.summary }));
vi.mock("@/lib/use-cases/labels", () => ({ listLabelsUseCase: m.list, createLabelUseCase: m.create, addItemLabelUseCase: m.add, removeItemLabelUseCase: m.remove }));
vi.mock("@/lib/use-cases/item-creation", () => ({ createExternalItemUseCase: m.createItem }));
vi.mock("@/lib/use-cases/items", () => ({ createItemUseCase: m.createItem, updateItemUseCase: m.updateItem }));
import { postItem, patchItem } from "@/lib/api/routes";
import { GET as getLabels, POST as postLabel, OPTIONS as catalogueOptions, PUT as unsupportedCatalogue } from "@/app/api/v1/backlogs/[key]/labels/route";
import { PUT as putItemLabel, DELETE as deleteItemLabel, OPTIONS as itemOptions, GET as unsupportedItem } from "@/app/api/v1/items/[key]/labels/[labelId]/route";
const handlers = { getLabels, postLabel, putItemLabel, deleteItemLabel, postItem, patchItem } as unknown as Record<string, (r: Request, c?: { params: Promise<{ key: string; labelId?: string }> }) => Promise<Response>>;
const labelId = "11111111-1111-4111-8111-111111111111";
const label = { id: labelId, backlogId: null, name: "Urgent", color: "--label-1" };
const actor = { actorId: "u", tokenId: "t", source: "api" };
const context = { params: Promise.resolve({ key: "TEST-1", labelId }) };
const backlogContext = { params: Promise.resolve({ key: "test" }) };
const request = (method = "GET", body?: unknown) => new Request("http://localhost/api/v1", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function call(name: string, req = request(), ctx: { params: Promise<{ key: string; labelId?: string }> } = context) {
  expect(handlers[name], `${name} is a REST handler`).toBeTypeOf("function");
  return handlers[name]!(req, ctx);
}
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "write" } });
  m.budget.mockResolvedValue({ allowed: true });
  m.backlog.mockResolvedValue({ backlogId: "b" }); m.item.mockResolvedValue({ id: "i", backlogId: "b" });
  m.list.mockResolvedValue([label]); m.create.mockResolvedValue({ label, created: true });
  m.add.mockResolvedValue({ changed: true }); m.remove.mockResolvedValue({ changed: false });
  m.createItem.mockResolvedValue({ item: { key: "TEST-1" } }); m.summary.mockResolvedValue({ key: "TEST-1" });
});
describe("REST label contracts", () => {
  it("declares supported methods and prevents caching for OPTIONS and 405", async () => {
    for (const [options, unsupported, allow] of [
      [catalogueOptions, unsupportedCatalogue, "GET, POST, HEAD, OPTIONS"],
      [itemOptions, unsupportedItem, "PUT, DELETE, OPTIONS"],
    ] as const) {
      const response = options(); expect(response.status).toBe(204); expect(response.headers.get("allow")).toBe(allow);
      const refused = unsupported(); expect(refused.status).toBe(405); expect(refused.headers.get("allow")).toBe(allow);
      expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(refused.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  it("lists the visible catalogue with read scope", async () => {
    m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "read" } });
    const response = await call("getLabels", request(), backlogContext);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ labels: [label] });
    expect(m.backlog).toHaveBeenCalledWith("u", "TEST"); expect(m.list).toHaveBeenCalledWith(actor, "b");
  });
  it.each([true, false])("creates or reuses a catalogue label (created=%s)", async (created) => {
    m.create.mockResolvedValue({ label, created });
    const response = await call("postLabel", request("POST", { name: "  Urgent  " }), backlogContext);
    expect(response.status).toBe(created ? 201 : 200); expect(await response.json()).toEqual({ label, created });
    expect(m.create).toHaveBeenCalledWith(actor, { backlogId: "b", name: "Urgent" });
  });
  it.each(["putItemLabel", "deleteItemLabel"])("%s returns an empty 204 for changes and no-ops", async (handler) => {
    const response = await call(handler, request(handler === "putItemLabel" ? "PUT" : "DELETE"));
    expect(response.status).toBe(204); expect(await response.text()).toBe("");
    expect(handler === "putItemLabel" ? m.add : m.remove).toHaveBeenCalledWith(actor, { itemId: "i", labelId });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["postLabel", "putItemLabel", "deleteItemLabel", "postItem"])("refuses read tokens on %s before touching resources", async (handler) => {
    m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "read" } });
    const response = await call(handler, request("POST", { name: "Urgent", backlogKey: "TEST", type: "composant", title: "x", labelIds: [labelId] }));
    expect(response.status).toBe(403); expect(m.backlog).not.toHaveBeenCalled(); expect(m.item).not.toHaveBeenCalled();
    for (const write of [m.create, m.add, m.remove, m.createItem]) expect(write).not.toHaveBeenCalled();
  });
  it.each(["postLabel", "putItemLabel", "deleteItemLabel"])("%s masks missing, foreign and unreadable resources", async (handler) => {
    const bodies = [];
    for (const reason of ["missing", "foreign", "unreadable"]) {
      const error = Object.assign(new Error(reason), { name: "ResourceNotFoundError" });
      (handler === "postLabel" ? m.create : handler === "putItemLabel" ? m.add : m.remove).mockRejectedValueOnce(error);
      const response = await call(handler, request(handler === "postLabel" ? "POST" : handler === "putItemLabel" ? "PUT" : "DELETE", handler === "postLabel" ? { name: "Urgent" } : undefined), handler === "postLabel" ? backlogContext : context);
      expect(response.status).toBe(404); bodies.push(await response.json());
    }
    expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
  });
  it.each([{}, { name: " " }, { name: "x".repeat(51) }, { name: "x", color: "red" }])("rejects invalid catalogue input %s", async (body) => {
    expect((await call("postLabel", request("POST", body), backlogContext)).status).toBe(400); expect(m.create).not.toHaveBeenCalled();
  });
  it("rejects malformed label ids before resolving resources", async () => {
    const response = await call("putItemLabel", request("PUT"), { params: Promise.resolve({ key: "TEST-1", labelId: "bad" }) });
    expect(response.status).toBe(400); expect(m.item).not.toHaveBeenCalled();
  });
  it("deduplicates initial label ids in REST", async () => {
    const response = await call("postItem", request("POST", { backlogKey: "TEST", type: "composant", title: "x", labelIds: [labelId, labelId] }));
    expect(response.status).toBe(201);
    expect(m.createItem).toHaveBeenCalledWith(actor, expect.objectContaining({ labelIds: [labelId] }));
  });
});

it("normalizes and deduplicates replacement labels in PATCH /items", async () => {
  const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
  const response = await call("patchItem", request("PATCH", { labelIds: [id.toUpperCase(), id] }));
  expect(response.status).toBe(200);
  expect(m.updateItem).toHaveBeenCalledWith(actor, { id: "i", labelIds: [id] });
});
it("normalizes an uppercase label id in PUT /items/{key}/labels/{id}", async () => {
  const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
  const response = await call("putItemLabel", request("PUT"), { params: Promise.resolve({ key: "TEST-1", labelId: id.toUpperCase() }) });
  expect(response.status).toBe(204);
  expect(m.add).toHaveBeenCalledWith(actor, { itemId: "i", labelId: id });
});
it.each(["postItem", "patchItem"])("%s returns the same 404 for foreign and unknown labels", async (handler) => {
  const bodies = [];
  for (const reason of ["foreign", "unknown"]) {
    (handler === "postItem" ? m.createItem : m.updateItem).mockRejectedValueOnce(Object.assign(new Error(reason), { name: "ResourceNotFoundError", resourceType: "label" }));
    const response = await call(handler, request(handler === "postItem" ? "POST" : "PATCH", handler === "postItem" ? { backlogKey: "TEST", type: "composant", title: "x", labelIds: [labelId] } : { labelIds: [labelId] }));
    expect(response.status).toBe(404);
    bodies.push(await response.json());
  }
  expect(bodies[0]).toEqual(bodies[1]);
});

it("accepts an empty replacement label list to clear labels in PATCH /items", async () => {
  const response = await call("patchItem", request("PATCH", { labelIds: [] }));
  expect(response.status).toBe(200);
  expect(m.updateItem).toHaveBeenCalledWith(actor, { id: "i", labelIds: [] });
});
