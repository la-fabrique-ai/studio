import { withApiAuth } from "@/lib/api/handler";
import { jsonOk, MAX_SPEC_JSON_BODY_BYTES, parseJson, problem } from "@/lib/api/http";
import {
  createSpecInput,
  findApiSpecIdByPath,
  getApiSpec,
  listApiSpecs,
  moveSpecInput,
  SPEC_ID,
  updateSpecInput,
} from "@/lib/api/specs";
import { restIdempotencyKey } from "@/lib/items/creation-request";
import { BACKLOG_KEY } from "@/lib/mcp/schemas";
import { SpecConflictError } from "@/lib/services/specs";
import { createExternalSpecUseCase } from "@/lib/use-cases/spec-creation";
import {
  moveSpecNodeUseCase,
  restoreSpecNodeUseCase,
  trashSpecNodeUseCase,
  updateSpecNodeUseCase,
} from "@/lib/use-cases/specs";

/** 409 with the revision to read again, like Confluence's version conflict. */
function conflict(error: SpecConflictError): Response {
  return problem("domain_error", {
    detail: error.message,
    extensions: { currentRevision: error.current.revision.toISOString() },
  });
}

type KeyParams = { key: string };
type IdParams = { id: string };

export const getSpecs = withApiAuth<KeyParams>("read", async (_request, actor, params) =>
  jsonOk(await listApiSpecs(actor, BACKLOG_KEY.parse(params.key))));

/** `?path=PRD/Stories/Story 1`: the node at that title path. */
export const getSpecByPath = withApiAuth<KeyParams>("read", async (request, actor, params) => {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const { id, backlogId } = await findApiSpecIdByPath(actor, BACKLOG_KEY.parse(params.key), path);
  return jsonOk({ node: await getApiSpec(actor, id, backlogId) });
});

/** 201 for a new node; 200 with `replayed: true` when an idempotency key was already used. */
export const postSpec = withApiAuth<KeyParams>("write", async (request, actor, params) => {
  const backlog = BACKLOG_KEY.parse(params.key);
  const fields = await parseJson(request, createSpecInput, MAX_SPEC_JSON_BODY_BYTES);
  const idempotencyKey = restIdempotencyKey(request.headers.get("Idempotency-Key"), fields.idempotencyKey);
  const { node, backlogId, replayed } = await createExternalSpecUseCase(actor, {
    ...fields, backlog, ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  return jsonOk({ node: await getApiSpec(actor, node.id, backlogId), replayed }, replayed ? 200 : 201);
});

export const getSpec = withApiAuth<IdParams>("read", async (_request, actor, params) =>
  jsonOk({ node: await getApiSpec(actor, params.id) }));

/** Title and/or text, in one transaction: a stale revision changes nothing. */
export const patchSpec = withApiAuth<IdParams>("write", async (request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  const input = await parseJson(request, updateSpecInput, MAX_SPEC_JSON_BODY_BYTES);
  try {
    const { backlogId } = await updateSpecNodeUseCase(actor, { id, ...input });
    return jsonOk({ node: await getApiSpec(actor, id, backlogId) });
  } catch (error) {
    if (error instanceof SpecConflictError) return conflict(error);
    throw error;
  }
});

export const postSpecMove = withApiAuth<IdParams>("write", async (request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  const { parentId, afterId } = await parseJson(request, moveSpecInput);
  const { backlogId } = await moveSpecNodeUseCase(actor, { id, parentId, afterId });
  return jsonOk({ node: await getApiSpec(actor, id, backlogId) });
});

export const deleteSpec = withApiAuth<IdParams>("write", async (_request, actor, params) => {
  const { ids } = await trashSpecNodeUseCase(actor, { id: SPEC_ID.parse(params.id) });
  return jsonOk({ trashedIds: ids });
});

export const postSpecRestore = withApiAuth<IdParams>("write", async (_request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  const { backlogId } = await restoreSpecNodeUseCase(actor, { id });
  return jsonOk({ node: await getApiSpec(actor, id, backlogId) });
});
