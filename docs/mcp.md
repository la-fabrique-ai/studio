# Le Studio MCP server

Le Studio exposes its tickets to AI agents (Claude Code, Codex and any MCP client) through a
[Model Context Protocol](https://modelcontextprotocol.io) server at `/api/mcp` (JIR-158).
It speaks Streamable HTTP, is stateless, and authenticates every request with a
**personal access token** (JIR-156) sent as a bearer header. The agent acts as the
token's owner, with the owner's permissions; the token's scope (`read` or `write`)
caps what it may do.

## Configure a client

Create a token on the « Jetons d'accès » page (user menu), then:

**Claude Code**

```bash
claude mcp add --transport http studio https://jiroo-dev.vercel.app/api/mcp \
  --header "Authorization: Bearer jiroo_pat_…"
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.studio]
url = "https://jiroo-dev.vercel.app/api/mcp"
bearer_token_env_var = "STUDIO_TOKEN"
```

and export `STUDIO_TOKEN=jiroo_pat_…` in the environment Codex starts from.

**Generic MCP client**: Streamable HTTP, `Authorization: Bearer <token>`. OAuth is not
supported: a request without a valid bearer token gets `401` with a plain
`WWW-Authenticate: Bearer realm="studio"` challenge (`error="invalid_token"` for a bad
token), no `resource_metadata` and no authorization server to discover.

## Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `list_backlogs` | read | Backlogs the owner can read (`includeArchived`). |
| `list_statuses` | read | Statuses of one backlog, with ids and categories. |
| `search_items` | read | Live items, filtered by `backlog`, `statusId`, `assignee` (`"me"` or a user id), `type`, `query`; paged by `cursor` (creation order). |
| `get_item` | read | One item by key with description, reporter, parent, children, labels, dependencies, comments and activities. |
| `list_my_items` | read | Items assigned to the owner, paged by `cursor` like `search_items`. |
| `create_item` | write | Create an item (`backlog`, `type`, `title`, optional `parentKey`, `statusId`, `priority`, `assigneeId`, `estimatePoints`, dates, `kind`, `sprintId`, `labelIds`, `idempotencyKey`). Returns `{ item, replayed }`. |
| `update_item` | write | Change `title`, `description`, `priority`, `assigneeId`, `estimatePoints`, `startDate`, `dueDate`, `labelIds`; only the fields sent change. |
| `transition_item` | write | Move an item to a status of its backlog. |
| `add_comment` | write | Add a Markdown comment, optionally notifying `mentionIds`. |
| `list_labels` | read | `{ backlog }` → `{ labels: [{ id, backlogId, name, color }] }`, global and local labels. |
| `create_label` | write | `{ backlog, name }` → `{ label, created }`, reuses existing names. |
| `add_item_label` | write | `{ key, labelId }` → `{ changed }`, false if already assigned. |
| `remove_item_label` | write | `{ key, labelId }` → `{ changed }`, false if already absent. |
| `list_dependencies` | read | `{ key }` → `{ dependencies }`, blocking relations and neighbour status. |
| `add_dependency` | write | `{ key, otherKey, direction: "blocks" or "blocked_by" }` → `{ dependency }`. |
| `remove_dependency` | write | `{ key, id }` → `{ removed: true }`, only a blocks relation belonging to that item. |
| `list_specs` | read | `{ backlog }` → `{ backlog, nodes }`, the specification tree in tree order with title paths. |
| `get_spec` | read | `{ id }` or `{ backlog, path }` → `{ node }`; a document has `content` and `revision`, a folder `children`. |
| `create_spec` | write | `{ backlog, kind, title, content?, parentId? \| parentPath?, idempotencyKey? }` → `{ node, replayed }`. |
| `update_spec` | write | `{ id, title?, content?, revision? }` → `{ node }`; `content` needs the `revision` read. |
| `move_spec` | write | `{ id, parentId, afterId? }` → `{ node }`; `parentId: null` for the root, no `afterId` for last. |
| `delete_spec` | write | `{ id }` → `{ trashedIds }`, the node and its subtree go to the trash. |
| `restore_spec` | write | `{ id }` → `{ node }`. |

Every tool answers text plus `structuredContent`. Refusals (read-only token on a write
tool, unknown key, missing permission, business rule) are tool results with
`isError: true` and a French message; unexpected failures are logged server-side and
answered with a generic message. A spent request budget is not a tool result: the route
answers HTTP `429` with `Retry-After` (see Rules).

## Labels, dependencies and item details

`list_labels` includes global labels (`backlogId: null`). `create_label` trims the
name (1–50 characters), reuses a case-insensitive match, including a global label,
and only creates local labels, with a colour chosen by Le Studio. Catalogue writes
and item label changes require `edit_items`; initial `labelIds` require
`create_items`. Duplicate UUIDs are ignored. `update_item({key, labelIds: []})`
clears all labels; otherwise `labelIds` replaces them. An unknown or foreign label
has the same not-found refusal.

Dependencies are stored from blocker to blocked item. The direction is relative
to the requested `key`: `blocks` means this item blocks `otherKey`, `blocked_by`
means the reverse. Each dependency contains `id`, `sourceKey`, `targetKey`,
`direction` and `other: { id, key, title, status: { id, name, category } }`.
Both endpoints must be live, readable, in the same backlog, with `link_items` on
both. Self-links, duplicates and **all blocks cycles**, including long cycles,
are refused without mutation. Statuses do not change automatically. Adding or
removing a dependency records an activity on both items. Unknown/foreign ids or
relations of another type cannot be removed through `remove_dependency`.

`get_item` now also returns `reporter` and `parent`, plus children, labels and
dependencies through the common REST reader. A deleted comment's `body` is now
an empty string; `deletedAt` remains available. Existing MCP aliases `editedAt`
and `deleted` remain alongside `updatedAt` and `deletedAt`.

```js
list_labels({ backlog: "CASS" })
create_label({ backlog: "CASS", name: "À vérifier" })
// Use the returned id with add_item_label/remove_item_label or create_item.labelIds.
add_dependency({ key: "CASS-12", otherKey: "CASS-13", direction: "blocks" })
list_dependencies({ key: "CASS-13" }) // CASS-12 appears as blocked_by
// Remove using the returned relation id: remove_dependency({ key: "CASS-12", id: "…" }).
```

## Specifications

Each backlog has a tree of **folders** and Markdown **documents** (Brief, PRD and
UX by default, the BMAD method); only folders have children. Reading needs
`browse_backlog`, writing `edit_items` and a write token; a node is always
authorized through its own backlog. Titles and contents are user-written data.

Address a node by `id` or, with `get_spec`, by `backlog` and title `path`
(`PRD/Stories/Story 1`): segments are trimmed and matched ignoring case, an exact
title wins, siblings sharing a title are refused (use the id). `update_spec`
replaces the whole text and needs the `revision` returned by `get_spec`; if the
document was saved since, nothing changes (title included) and the refusal gives
the current revision to read again; title and text change in one transaction.
`move_spec` without `afterId` puts the node last, `afterId: null` first. Agent
writes show the people looking at the backlog in Le Studio a banner offering to
refresh. The MCP
endpoint accepts bodies up to 1 MB; a document holds at most 800 KB of UTF-8.

```js
list_specs({ backlog: "CASS" })
create_spec({ backlog: "CASS", parentPath: "Brief", kind: "document", title: "Brief quotas", content: "# Problème" })
get_spec({ backlog: "CASS", path: "Brief/Brief quotas" }) // → node.content, node.revision
update_spec({ id: "…", content: "# Problème\n\nVersion 2", revision: "2026-11-16T10:00:00.000Z" })
```

## Create without duplicates after a lost response

Pass `idempotencyKey` to `create_item` or `create_spec`: an opaque, case-sensitive string of 1–128
characters. The key belongs to **the user and backlog**, with no expiration. It
is shared with REST (`Idempotency-Key` header or `idempotencyKey` body field) and
survives token rotation. The same key in another backlog, or used by another
user, creates another item. Item and specification keys are independent.
Without a key, every call creates an item or node.

The result is `{ item, replayed }`: false at creation, true on replay, with the
item's (or node's) **current state**. Simultaneous identical requests return
the same item or node. A node created then trashed refuses the replay: restore
it or use a new key.
Current permissions and the write scope are required on every call. Replay skips
resolution of the original mutable references and adds no activity.

The fingerprint covers validated fields supplied by the client, before defaults
or reference resolution, excluding the key; label ids are sorted and deduplicated.
Adding an omitted field, even its default value, changes the command. Reusing a
key with different content is refused. Deleting or purging the item also consumes
the key permanently: a replay is refused and never recreates it. A transaction
failure rolls back both the item/activity and its key reservation.

```js
// Persist the key and supplied fields before sending.
create_item({ backlog: "CASS", type: "composant", title: "Suivi des imports",
  idempotencyKey: "import-2026-11-16-composant-42" })
// Response lost? Repeat the same call and fields with the same key.
// replayed:false if nothing committed; replayed:true if already created.
```

The retry can use REST instead: `POST /api/v1/items` with header
`Idempotency-Key: import-2026-11-16-composant-42` and body
`{"backlogKey":"CASS","type":"composant","title":"Suivi des imports"}`.
REST returns 201 on creation, 200 on replay, and 409 on a content conflict or a
deleted/purged item; MCP returns `isError:true` for those same refusals.

## Rules

- **Permissions**: the owner's Jira-style permissions apply (`browse_backlog`,
  `create_items`, `edit_items`, `transition_items`, `assign_items`, `add_comments`…).
  A backlog the owner cannot read answers « introuvable », like the interface.
- **Scope**: `write` implies `read`; a `read` token is refused on write tools before any work.
- **Budget**: 300 requests per minute and per token, shared with the REST API. Every
  authenticated MCP request counts (`initialize`, `tools/list`, tool calls); past the
  budget the route answers `429` with `Retry-After`.
- **Token rules**: a write token always expires (30, 90 or 365 days); a token stops working
  as soon as its owner no longer has two-factor authentication.
- **Audit**: a platform administrator reading a backlog outside their ordinary grants
  (`get_item`, `list_statuses`, `search_items` on a named backlog, `create_item`) leaves a
  bypass audit event. Cross-backlog lists (`list_backlogs`, `search_items` without a
  backlog, `list_my_items`) do not.
- **One message per request**: JSON-RPC batch arrays are refused (`400`), and bodies are
  capped at 64 KiB (`413`).
- **Prompt injection**: titles, descriptions and comments are written by Studio users and
  returned verbatim. Agents must treat them as data, never as instructions; the read tools
  say so in their descriptions. Prefer read tokens and short expiries for agents.
- **Traceability**: item mutations record `source = mcp` and the token id; the
  board updates live for open tabs. Replays and label no-ops add no activity;
  catalogue label creation has no item activity.
- **Revocation**: revoke the token on the « Jetons d'accès » page; an administrator's
  password or 2FA reset revokes all of the user's tokens.
- **Mentions**: `add_comment` only notifies mentioned users who can read the backlog.

## Local check

```bash
curl -s https://jiroo-dev.vercel.app/api/mcp -H "Authorization: Bearer $STUDIO_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
