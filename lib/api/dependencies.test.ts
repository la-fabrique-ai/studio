import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), budget: vi.fn(), item: vi.fn(), list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/authenticate", () => ({ authenticateBearer: m.auth, bearerChallenge: () => "Bearer" }));
vi.mock("@/lib/api/rate-limit", () => ({ reserveApiRequest: m.budget }));
vi.mock("@/lib/services/api-tokens", () => ({ scopeAllows: (g: string, r: string) => g === "write" || r === "read" }));
vi.mock("@/lib/services/api-read", () => ({ resolveApiItem: m.item }));
vi.mock("@/lib/use-cases/links", () => ({ listDependenciesUseCase: m.list, addDependencyUseCase: m.add, removeDependencyUseCase: m.remove }));
import { GET, POST, OPTIONS, DELETE as unsupported } from "@/app/api/v1/items/[key]/dependencies/route";
import { DELETE, OPTIONS as deleteOptions, POST as unsupportedDelete } from "@/app/api/v1/items/[key]/dependencies/[id]/route";
const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
const dependency = { id, sourceKey: "TEST-1", targetKey: "TEST-2", direction: "blocks", other: { id: "j", key: "TEST-2", title: "Other", status: { id: "s", name: "Todo", category: "todo" } } };
const actor = { actorId: "u", tokenId: "t", source: "api" };
const context = { params: Promise.resolve({ key: "test-1", id: id.toUpperCase() }) };
const req = (method = "GET", body?: unknown) => new Request("http://localhost/api/v1", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "write" } }); m.budget.mockResolvedValue({ allowed: true });
  m.item.mockImplementation(async (_actor, key) => ({ id: key === "TEST-1" ? "i" : "j", key, backlogId: "b" }));
  m.list.mockResolvedValue([dependency]); m.add.mockResolvedValue({ dependency }); m.remove.mockResolvedValue({ removed: true });
});
it("lists dependencies with read scope and normalized keys", async () => {
  m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "read" } });
  const response = await GET(req(), context);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ dependencies: [dependency] });
  expect(m.item).toHaveBeenCalledWith("u", "TEST-1"); expect(m.list).toHaveBeenCalledWith(actor, "i");
});
it.each(["blocks", "blocked_by"])("adds %s relative to the requested item", async (direction) => {
  const response = await POST(req("POST", { otherKey: " test-2 ", direction }), context);
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ dependency });
  expect(m.add).toHaveBeenCalledWith(actor, { itemId: "i", otherId: "j", direction });
});
it("deletes only a dependency attached to the item and returns an empty 204", async () => {
  const response = await DELETE(req("DELETE"), context);
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(m.remove).toHaveBeenCalledWith(actor, { itemId: "i", id });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each([POST, DELETE])("refuses read scope before resource resolution", async (handler) => {
  m.auth.mockResolvedValue({ ok: true, principal: { actorId: "u", tokenId: "t", scope: "read" } });
  expect((await handler(req("POST", { otherKey: "TEST-2", direction: "blocks" }), context)).status).toBe(403);
  expect(m.item).not.toHaveBeenCalled(); expect(m.add).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
});
it.each([{}, { otherKey: "TEST-2", direction: "relates" }, { otherKey: "bad", direction: "blocks" }, { otherKey: "TEST-2", direction: "blocks", extra: true }])("rejects invalid or unknown input %j", async (body) => {
  expect((await POST(req("POST", body), context)).status).toBe(400); expect(m.item).not.toHaveBeenCalled();
});
it("rejects self links with 400 before mutation", async () => {
  expect((await POST(req("POST", { otherKey: "TEST-1", direction: "blocks" }), context)).status).toBe(400); expect(m.add).not.toHaveBeenCalled();
});
it("rejects malformed dependency ids before resolving the item", async () => {
  expect((await DELETE(req("DELETE"), { params: Promise.resolve({ key: "TEST-1", id: "bad" }) })).status).toBe(400); expect(m.item).not.toHaveBeenCalled();
});
it("maps cycles and duplicates to 409, hiding unknown errors", async () => {
  for (const message of ["Ce lien existe déjà.", "Cycle : cette dépendance créerait un blocage circulaire."]) {
    m.add.mockRejectedValueOnce(new Error(message));
    expect((await POST(req("POST", { otherKey: "TEST-2", direction: "blocks" }), context)).status).toBe(409);
  }
});
it.each([GET, POST, DELETE])("masks foreign, unreadable and missing resources identically", async (handler) => {
  const bodies = [];
  for (const message of ["foreign", "unreadable", "missing"]) {
    m.item.mockRejectedValueOnce(Object.assign(new Error(message), { name: "ResourceNotFoundError" }));
    const response = await handler(req(handler === GET ? "GET" : "POST", handler === POST ? { otherKey: "TEST-2", direction: "blocks" } : undefined), context);
    expect(response.status).toBe(404); bodies.push(await response.json());
  }
  expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
});
it("declares methods and disables caching for OPTIONS and 405", () => {
  for (const [options, refused, allow] of [[OPTIONS, unsupported, "GET, POST, HEAD, OPTIONS"], [deleteOptions, unsupportedDelete, "DELETE, OPTIONS"]] as const) {
    expect(options().status).toBe(204); expect(refused().status).toBe(405);
    for (const response of [options(), refused()]) { expect(response.headers.get("allow")).toBe(allow); expect(response.headers.get("cache-control")).toBe("private, no-store"); }
  }
});
