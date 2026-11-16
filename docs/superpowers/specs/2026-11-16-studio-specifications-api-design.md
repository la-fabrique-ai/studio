# Spécifications — accès API et MCP (lot 2) — conception (2026-11-16)

- **État :** validé — validation du propriétaire dans la session Claude Code du 16 novembre 2026 (« Oui, valide-le »), avec les choix recommandés.
- **Dépend de :** lot 1, [conception](2026-11-16-studio-specifications-design.md), PR #189.
- **Linear :** NON SYNCHRONISÉ — voir [linear-pending.md](../../linear-pending.md).

## Objectif

Permettre aux agents (Claude Code par le MCP, scripts par l'API REST) de lire
et d'écrire les spécifications d'un projet, avec les jetons d'accès existants
et les droits de leur propriétaire (lecture : `browse_backlog`, écriture :
`edit_items`).

## Référence

L'API v2 de Confluence expose les pages et leurs enfants ; une mise à jour porte
la version courante et répond 409 en cas de conflit
([Atlassian](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)).
Le Studio applique le même principe avec la `revision` du document.

## Décisions du propriétaire (16 novembre 2026)

1. Branche `lot-specs-api` empilée sur `lot-specs-documents` (PR #189).
2. Corps de requête jusqu'à 1 Mo pour les routes de spécifications seulement.
3. `get_spec` accepte un identifiant ou un chemin (`PRD/Stories/Story 1`).
4. Les écritures par API ou MCP rafraîchissent les onglets ouverts ; les saisies
   de l'éditeur ne le font pas.

## REST (`/api/v1`)

| Route | Portée | Rôle |
| --- | --- | --- |
| `GET /backlogs/{key}/specs` | read | Arborescence à plat, ordre de l'arbre : `id, parentId, kind, title, path, updatedAt` |
| `GET /specs/{id}` | read | Un nœud ; document : contenu et `revision` ; dossier : enfants |
| `POST /backlogs/{key}/specs` | write | Créer un dossier ou un document, contenu initial facultatif — 201 |
| `PATCH /specs/{id}` | write | Titre et/ou contenu ; le contenu exige `revision`, sinon 409 avec la révision courante |
| `POST /specs/{id}/move` | write | `parentId`, `afterId` |
| `DELETE /specs/{id}` | write | Corbeille du sous-arbre — `{ trashedIds }` |
| `POST /specs/{id}/restore` | write | Restauration |

## MCP

`list_specs`, `get_spec` (id ou chemin), `create_spec`, `update_spec`,
`move_spec`, `delete_spec`, `restore_spec`. Réponses texte et
`structuredContent` ; refus en français avec `isError`.

## Transverse

- Contenu initial accepté à la création d'un document.
- Journal : source `api`/`mcp` et jeton, par le contexte d'acteur existant.
- Limite de débit et audit des accès administrateur repris de l'existant.
- Documentation : `docs/api-v1.md`, `docs/mcp.md`, page d'aide.

## Hors périmètre

Agents BMAD, liens documents ↔ tickets, historique des versions, clé
d'idempotence à la création (une création rejouée peut dupliquer).

## Critères de validation

Tests unitaires (schémas, routes, outils), tests d'intégration avec base (jeton
lecture seule refusé, conflit 409, isolation entre projets), typecheck, lint,
appel réel de l'API et du MCP avec un jeton local.
