# Docker image

For the managed local environment and the future app + PostgreSQL VM stack,
see [infrastructure](../.infra/README.md). For versioned GHCR images and GitHub
draft releases, see [application releases](releases.md). The commands below
remain useful for standalone builds and maintenance.

Build from a reviewed checkout with Docker. No database, auth secret or dotenv
file is needed at build time. Corepack reads the pinned pnpm from `package.json`;
dependencies use the frozen lockfile. One image contains the app and maintenance:

```sh
STUDIO_IMAGE_TAG=0.1.0-$(git rev-parse --short HEAD)
docker build --target runner -t "studio:$STUDIO_IMAGE_TAG" .
```

The `runner` target runs standalone Next.js as `node` on port 3000 by default.
The same image retains the locked dependencies (including development tools and
`tsx`) and maintenance sources. This trades a larger image for reusing the existing
scripts without a second compilation pipeline. The app lives in `/app/server`;
maintenance runs from `/app`. The preloaded Corepack cache works offline.
No maintenance command runs when the application process starts.

## Connect to PostgreSQL

Supply secrets from the operator's environment or secret store, never as image
build arguments or committed files. Both URLs must be reachable **from inside
the container**: `localhost` refers to that container, not the host.

For a local host database, add
`--add-host=host.docker.internal:host-gateway` to each `docker run`, and use
`host.docker.internal` in the database URLs. On the current development machine,
Le Studio uses port 5434; 5433 belongs to another project. No database port needs to
be published by these images. For a database on a Docker network, attach each
container with `--network <existing-network>` and use its database service name.

Create the database and its owner/runtime roles separately. See
[Database roles](database-roles.md) for the required PostgreSQL privileges.
`DIRECT_DATABASE_URL` uses the schema owner; `DATABASE_URL` uses the restricted
runtime role. Set `STUDIO_RUNTIME_ROLE` to that existing role's name.

## Migrate, grant and bootstrap

For standalone Docker runs, migrate before starting or updating the application.
The VM Compose file performs this step through its `migrate` service:

```sh
docker run --rm --no-healthcheck -e DIRECT_DATABASE_URL "studio:$STUDIO_IMAGE_TAG" corepack pnpm db:migrate
docker run --rm --no-healthcheck -e DIRECT_DATABASE_URL -e STUDIO_RUNTIME_ROLE \
  "studio:$STUDIO_IMAGE_TAG" corepack pnpm db:grant-runtime
```

`db:migrate` refuses a missing direct URL. Granting runtime rights is idempotent; repeat it after migrations.

For the first administrator only, supply the application's `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and the three `STUDIO_ADMIN_*` variables
from [First administrator](first-administrator.md), then run:

```sh
docker run --rm --no-healthcheck -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL \
  -e STUDIO_ADMIN_EMAIL -e STUDIO_ADMIN_NAME -e STUDIO_ADMIN_PASSWORD \
  "studio:$STUDIO_IMAGE_TAG" corepack pnpm db:bootstrap-admin
unset STUDIO_ADMIN_EMAIL STUDIO_ADMIN_NAME STUDIO_ADMIN_PASSWORD
```

This creates no demo data. Keep the auth secret stable; two-factor enrollment
is required at first sign-in. Do not run `db:seed` in production.

## Run and verify

Set `BETTER_AUTH_URL` to the exact public origin served by your reverse proxy.
Keep the owner's direct URL and administrator credentials out of this container:

```sh
docker run --detach --name studio-app --init --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL \
  "studio:$STUDIO_IMAGE_TAG"
docker inspect --format '{{.State.Health.Status}}' studio-app
```

Forward requests through the TLS reverse proxy. Check `/login` and `/api/health`.
The health endpoint returns 200 when PostgreSQL answers, or an opaque 503 when
it does not. The built-in Node probe checks it every 30 seconds (5-second probe
timeout, 10-second start period, three failures before `unhealthy`); it needs
neither curl nor wget. Docker health status alone does not restart a container.

These commands build and run local images; registry publication, deployment,
backup/rollback procedures and the DSI's image vulnerability scan are separate
release steps. Never use a mutable `latest` tag for production.
