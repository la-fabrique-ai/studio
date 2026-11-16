import { withApiAuth } from "@/lib/api/handler";
import { jsonOk, MAX_SPEC_JSON_BODY_BYTES, parseJson, problem } from "@/lib/api/http";
import {
  createSpecInput,
  findApiSpecIdByPath,
  findSpecIdInBacklog,
  getApiSpec,
  listApiSpecs,
  moveSpecInput,
  SPEC_ID,
  updateSpecInput,
} from "@/lib/api/specs";
import { BACKLOG_KEY } from "@/lib/mcp/schemas";
import { resolveApiBacklog } from "@/lib/services/api-read";
import { SpecConflictError } from "@/lib/services/specs";
import {
  createSpecNodeUseCase,
  moveSpecNodeUseCase,
  renameSpecNodeUseCase,
  restoreSpecNodeUseCase,
  trashSpecNodeUseCase,
  updateSpecContentUseCase,
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
  const { id } = await findApiSpecIdByPath(actor, BACKLOG_KEY.parse(params.key), path);
  return jsonOk({ node: await getApiSpec(actor, id) });
});

export const postSpec = withApiAuth<KeyParams>("write", async (request, actor, params) => {
  const key = BACKLOG_KEY.parse(params.key);
  const { parentPath, parentId, ...input } = await parseJson(request, createSpecInput, MAX_SPEC_JSON_BODY_BYTES);
  const backlog = await resolveApiBacklog(actor.actorId, key);
  const parent = parentPath ? await findSpecIdInBacklog(backlog.backlogId, parentPath) : parentId ?? null;
  const node = await createSpecNodeUseCase(actor, { ...input, parentId: parent, backlogId: backlog.backlogId });
  return jsonOk({ node: await getApiSpec(actor, node.id) }, 201);
});

export const getSpec = withApiAuth<IdParams>("read", async (_request, actor, params) =>
  jsonOk({ node: await getApiSpec(actor, params.id) }));

/**
 * Title and/or text. The text goes first: a stale revision refuses the whole
 * request before the title changes.
 */
export const patchSpec = withApiAuth<IdParams>("write", async (request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  const input = await parseJson(request, updateSpecInput, MAX_SPEC_JSON_BODY_BYTES);
  if (input.content !== undefined) {
    try {
      await updateSpecContentUseCase(actor, { id, content: input.content, revision: input.revision! });
    } catch (error) {
      if (error instanceof SpecConflictError) return conflict(error);
      throw error;
    }
  }
  if (input.title !== undefined) await renameSpecNodeUseCase(actor, { id, title: input.title });
  return jsonOk({ node: await getApiSpec(actor, id) });
});

export const postSpecMove = withApiAuth<IdParams>("write", async (request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  const { parentId, afterId } = await parseJson(request, moveSpecInput);
  await moveSpecNodeUseCase(actor, { id, parentId, afterId: afterId ?? null });
  return jsonOk({ node: await getApiSpec(actor, id) });
});

export const deleteSpec = withApiAuth<IdParams>("write", async (_request, actor, params) => {
  const { ids } = await trashSpecNodeUseCase(actor, { id: SPEC_ID.parse(params.id) });
  return jsonOk({ trashedIds: ids });
});

export const postSpecRestore = withApiAuth<IdParams>("write", async (_request, actor, params) => {
  const id = SPEC_ID.parse(params.id);
  await restoreSpecNodeUseCase(actor, { id });
  return jsonOk({ node: await getApiSpec(actor, id) });
});
