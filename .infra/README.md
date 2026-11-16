# Infrastructure

The application stays in its existing Next.js structure. Infrastructure borrows
the Portail's separation of local configuration, container builds and releases,
without its multi-application, GitLab, Ansible or encrypted-vault tooling.

## Local development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:setup
corepack pnpm services:start
corepack pnpm db:migrate
corepack pnpm dev
```

`env:setup` creates `.infra/local/.env` from the root `.env.example`, generates
an auth secret and demo administrator password, and links root `.env` to it.
Next.js, dotenv-based maintenance scripts and Docker Compose read that same
file. The secret file is ignored by Git, excluded from Docker builds and created
with owner-only permissions. Repeating setup preserves its contents.

An existing root `.env` or development override is never overwritten. Reconcile
it manually first. Shell environment variables still take precedence: unset old
cloud `DATABASE_URL` / `DIRECT_DATABASE_URL` exports when switching to local.
There is no cloud connection in the generated configuration and no cloud data
is imported automatically.

The database runs in PostgreSQL 17 with a persistent Docker volume. Port **5434**
is bound to **127.0.0.1** only (5433 is used by another local project). Change
`POSTGRES_PORT` and both database URLs together if necessary. The database
credentials are development-only. Changing credentials in the env file does not
change roles in an already initialized PostgreSQL volume.

`services:stop` stops PostgreSQL without removing its data. `services:status`
and `services:logs` inspect it. Do not use `docker compose down -v` unless you
intend to delete the local database. The existing volume key is preserved.

For demo data, explicitly run `pnpm db:seed`; its generated credentials are in
the local env file. For a clean installation use [administrator bootstrap](../docs/first-administrator.md).
No seed runs automatically.

## Future single-VM deployment

`compose.vm.yml` is a standalone Compose file: one application container and one
PostgreSQL container on the same Docker network, plus a maintenance profile.
PostgreSQL has **no published host port**. A host TLS reverse proxy forwards to
the application's loopback port. No external database service is required.

1. Copy `.infra/.env.vm.example` to `.infra/.env.vm` and fill its values. Use
   `db:5432` in both URLs, a restricted runtime role for `DATABASE_URL`, and the
   owner for `DIRECT_DATABASE_URL`. Keep passwords URL-encoded; hexadecimal
   passwords avoid escaping issues. Keep `BETTER_AUTH_SECRET` stable.
2. Fill both image references from the release's `release-manifest.json`, using
   the digests. Authenticate to GHCR on the VM if the packages are private.
3. Start the database, provision the runtime role using
   [database roles](../docs/database-roles.md), then run migrations and grants:

   ```sh
   docker compose --env-file .infra/.env.vm -f .infra/compose.vm.yml up -d --wait db
   docker compose --env-file .infra/.env.vm -f .infra/compose.vm.yml run --rm migrate
   docker compose --env-file .infra/.env.vm -f .infra/compose.vm.yml run --rm migrate corepack pnpm db:grant-runtime
   docker compose --env-file .infra/.env.vm -f .infra/compose.vm.yml up -d --wait app
   ```

4. Bootstrap the first administrator with the maintenance image, following
   [the existing guide](../docs/first-administrator.md), and verify `/api/health`.

The app receives neither the owner's URL nor the owner's password. Maintenance
is explicit, never an application startup action. This is deployment preparation;
TLS, backups, restore validation and actual VM deployment remain operational
steps. The volume belongs to Compose project `jiroo`; do not change that project
name when upgrading. A rollback of an image does not roll back database changes.

## Releases

See [releases](../docs/releases.md). Application and maintenance images are built
from the same commit. UI/server/shared extraction remains a separate future change.

## Shared tooling

The `.bin/shared` Git submodule points explicitly to
`https://github.com/la-fabrique-ai/shared-bin.git`, using the same location as
Portail but the La Fabrique repository. Initialize the pinned revision after
cloning Studio:

```sh
git submodule update --init --recursive .bin/shared
```

Alternatively, clone Studio with `git clone --recurse-submodules`. Access to the
shared repository is required. A submodule includes committed files only, not
uncommitted scripts from a sibling working directory. Updating shared tooling
requires committing and publishing it there, then updating Studio's submodule
revision in a reviewed change.

The GitHub build and release workflows do not invoke shared-bin,
so they do not fetch it or require a cross-repository token. Local commands use
the `.bin/product` launcher; see [local image builds](../docs/releases.md#build-and-publish-images-from-your-computer).
The submodule is
excluded from Docker build contexts. When wiring shared commands into CI, use
credentials scoped to the La Fabrique repository, never the Portail's credentials.
