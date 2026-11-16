import { withApiAuth } from "@/lib/api/handler";
import { jsonOk, parseJson } from "@/lib/api/http";
import { commentRestInput, createRestItemInput, createRestLabelInput, parseSearchParams, updateRestItemInput } from "@/lib/api/schemas";
import { BACKLOG_KEY, ITEM_KEY, itemLabelInput, addDependencyInput, dependencyBodyInput, removeDependencyInput } from "@/lib/mcp/schemas";
import { getApiComment, getApiItemDetail, getApiItemSummary, getApiMe, listApiBacklogs, listApiStatuses, resolveApiBacklog, resolveApiItem } from "@/lib/services/api-read";
import { searchItemsForActor } from "@/lib/services/item-search";
import { addCommentUseCase } from "@/lib/use-cases/comments";
import { createItemUseCase, updateItemUseCase } from "@/lib/use-cases/items";
import { addItemLabelUseCase, createLabelUseCase, listLabelsUseCase, removeItemLabelUseCase } from "@/lib/use-cases/labels";

import { listDependenciesUseCase, addDependencyUseCase, removeDependencyUseCase } from "@/lib/use-cases/links";

export const getLabels = withApiAuth<{ key: string }>("read", async (_request, actor, params) => {
  const backlog = await resolveApiBacklog(actor.actorId, BACKLOG_KEY.parse(params.key));
  return jsonOk({ labels: await listLabelsUseCase(actor, backlog.backlogId) });
});
export const postLabel = withApiAuth<{ key: string }>("write", async (request, actor, params) => {
  const key = BACKLOG_KEY.parse(params.key);
  const input = await parseJson(request, createRestLabelInput);
  const backlog = await resolveApiBacklog(actor.actorId, key);
  const result = await createLabelUseCase(actor, { ...input, backlogId: backlog.backlogId });
  return jsonOk(result, result.created ? 201 : 200);
});
type ItemLabelParams = { key: string; labelId: string };
export const putItemLabel = withApiAuth<ItemLabelParams>("write", async (_request, actor, params) => {
  const { key, labelId } = itemLabelInput.parse(params);
  const item = await resolveApiItem(actor.actorId, key);
  await addItemLabelUseCase(actor, { itemId: item.id, labelId });
  return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
});
export const deleteItemLabel = withApiAuth<ItemLabelParams>("write", async (_request, actor, params) => {
  const { key, labelId } = itemLabelInput.parse(params);
  const item = await resolveApiItem(actor.actorId, key);
  await removeItemLabelUseCase(actor, { itemId: item.id, labelId });
  return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
});

export const getMe = withApiAuth("read", async (_request, actor) => jsonOk(await getApiMe(actor.actorId, actor.tokenId!)));
export const getBacklogs = withApiAuth("read", async (_request, actor) => jsonOk({ backlogs: await listApiBacklogs(actor.actorId) }));
export const getStatuses = withApiAuth<{ key: string }>("read", async (_request, actor, params) => jsonOk({ statuses: await listApiStatuses(actor.actorId, BACKLOG_KEY.parse(params.key)) }));
export const getItems = withApiAuth("read", async (request, actor) => {
  const { backlog, query, statusId, ...filters } = parseSearchParams(request.url);
  // A named backlog is authorized (and audited for an administrator) first;
  // an unreadable one answers 404 like an unknown one.
  if (backlog) await resolveApiBacklog(actor.actorId, backlog);
  return jsonOk(await searchItemsForActor(actor.actorId, { ...filters, backlogKey: backlog, statusId, query }));
});
export const getItem = withApiAuth<{ key: string }>("read", async (_request, actor, params) => jsonOk({ item: await getApiItemDetail(actor.actorId, ITEM_KEY.parse(params.key)) }));
/** At most this many items in one /me/items answer; beyond, follow nextCursor (JIR-160). */
export const MY_ITEMS_MAX_PAGES = 10;

export const getMyItems = withApiAuth("read", async (request, actor) => {
  const items = [];
  let cursor: string | null = new URL(request.url).searchParams.get("cursor");
  let pages = 0;
  do {
    const page = await searchItemsForActor(actor.actorId, { assignee: "me", limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < MY_ITEMS_MAX_PAGES);
  return jsonOk({ items, nextCursor: cursor });
});
export const postItem = withApiAuth("write", async (request, actor) => {
  const { backlogKey, parentKey, ...input } = await parseJson(request, createRestItemInput);
  const backlog = await resolveApiBacklog(actor.actorId, backlogKey);
  const parent = parentKey ? await resolveApiItem(actor.actorId, parentKey) : null;
  const result = await createItemUseCase(actor, { ...input, backlogId: backlog.backlogId, parentId: parent?.id ?? null });
  return jsonOk({ item: await getApiItemSummary(actor.actorId, result.item.key) }, 201);
});
export const patchItem = withApiAuth<{ key: string }>("write", async (request, actor, params) => {
  const key = ITEM_KEY.parse(params.key);
  const input = await parseJson(request, updateRestItemInput);
  const item = await resolveApiItem(actor.actorId, key);
  await updateItemUseCase(actor, { ...input, id: item.id });
  return jsonOk({ item: await getApiItemSummary(actor.actorId, key) });
});
export const postComment = withApiAuth<{ key: string }>("write", async (request, actor, params) => {
  const key = ITEM_KEY.parse(params.key);
  const input = await parseJson(request, commentRestInput);
  const item = await resolveApiItem(actor.actorId, key);
  const { comment } = await addCommentUseCase(actor, { ...input, itemId: item.id });
  return jsonOk({ comment: await getApiComment(actor.actorId, key, comment.id) }, 201);
});

export const getDependencies = withApiAuth<{ key: string }>("read", async (_request, actor, params) => {
  const item = await resolveApiItem(actor.actorId, ITEM_KEY.parse(params.key));
  return jsonOk({ dependencies: await listDependenciesUseCase(actor, item.id) });
});
export const postDependency = withApiAuth<{ key: string }>("write", async (request, actor, params) => {
  const body = await parseJson(request, dependencyBodyInput);
  const { key, otherKey, direction } = addDependencyInput.parse({ key: params.key, ...body });
  const item = await resolveApiItem(actor.actorId, key);
  const other = await resolveApiItem(actor.actorId, otherKey);
  return jsonOk(await addDependencyUseCase(actor, { itemId: item.id, otherId: other.id, direction }), 201);
});
export const deleteDependency = withApiAuth<{ key: string; id: string }>("write", async (_request, actor, params) => {
  const { key, id } = removeDependencyInput.parse(params);
  const item = await resolveApiItem(actor.actorId, key);
  await removeDependencyUseCase(actor, { itemId: item.id, id });
  return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
});
