# Spécifications — conception (2026-11-16)

- **État :** validé (lot 1) — validation du propriétaire dans la session Claude Code du 16 novembre 2026 (« Oui, lance le lot 1 »).
- **Source :** maquette « La Fabrique » V3 (canvas Design, artboards `PilotV3`, `SidebarV3`, `TopbarV3`) et demande du propriétaire du 16 novembre 2026.
- **Linear :** NON SYNCHRONISÉ — voir [linear-pending.md](../../linear-pending.md).

## Objectif

Ajouter à chaque projet (backlog) une section **Spécifications** : des documents
Markdown rangés dans une arborescence de dossiers, stockés dans le Postgres du
Studio. La structure par défaut suit la méthode BMAD : dossiers **Brief**, **PRD**
et **UX**, avec sous-dossiers et documents libres en dessous.

## Référence Jira

Jira délègue les documents à Confluence : son onglet *Docs* connecte un espace,
un dossier ou une page Confluence à un espace Jira
([Atlassian — Docs feature](https://support.atlassian.com/jira-software-cloud/docs/pages-for-next-gen-projects/)).
Confluence organise les contenus en arbre de pages et de dossiers. Le Studio en
retient la version simple : un arbre par projet, fait de **dossiers** et de
**documents** ; seuls les dossiers ont des enfants. Le lien page ↔ ticket
([Atlassian](https://support.atlassian.com/jira-software-cloud/docs/link-a-confluence-page-to-an-epic))
est reporté.

## Décisions du propriétaire (16 novembre 2026)

1. **Périmètre :** documents seuls ; les agents IA BMAD (terminal, validation par étape) sont un chantier séparé.
2. **Structure :** arbre libre pré-rempli — Brief, PRD et UX sont créés par défaut, mais restent renommables, déplaçables et supprimables.
3. **Accès agents :** REST et MCP dans un lot 2 séparé.
4. **Liens tickets :** plus tard.

## Lot 1 — périmètre

- Table `spec_nodes` : `id`, `backlog_id`, `parent_id` (nullable, même backlog), `kind` (`folder` | `document`), `title`, `content` (Markdown, documents seulement), `rank` (LexoRank), `revision` (concurrence optimiste), `created_by`, `updated_by`, `created_at`, `updated_at`, `deleted_at`.
- Dossiers Brief, PRD et UX créés à la création d'un projet ; migration de rattrapage pour les projets existants.
- Service : validation Zod → mutation → journal, en une transaction. Opérations : créer, renommer, déplacer (pas de cycle, pas d'enfant sous un document, même projet), modifier le contenu (révision attendue), mettre à la corbeille (sous-arbre), restaurer.
- Droits sans nouvelle permission : lecture = `browse_backlog`, écriture = `edit_items`.
- Écran `/b/[key]/specs` et `/b/[key]/specs/[id]` : arbre à gauche, document à droite avec l'éditeur Markdown existant et enregistrement automatique ; fil d'Ariane ; état vide.
- Barre latérale : section « Spécifications » listant les dossiers racines du projet actif.

## Hors périmètre

Agents IA, liens tickets, historique des versions, commentaires sur documents,
API/MCP (lot 2).

## Critères de validation

Tests ciblés (service, règles d'arbre, composants), suite `pnpm test`,
`pnpm typecheck`, `pnpm lint`, parcours manuel dans le navigateur (créer un
dossier, un document, éditer, déplacer, supprimer).
