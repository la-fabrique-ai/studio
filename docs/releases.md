# Application releases

`package.json` is the source of the stable **X.Y.Z** version (for example 0.1.0,
0.2.0). These are releases of Jiroo itself, separate from the business releases
managed inside the application. No version is bumped automatically.

## Prepare a release

1. Change the package version in a reviewed PR, merge it into `main`.
2. In GitHub Actions, run **Prepare release** on `main`, entering exactly that
   version. The selected commit stays fixed throughout the run.
3. The workflow rejects an existing version tag or release, runs CI (audit,
   typecheck, lint, unit/component tests and both Docker builds), then publishes:
   - `ghcr.io/<owner>/<repo>:X.Y.Z` and `:sha-<full-commit>` — application;
   - `ghcr.io/<owner>/<repo>-migrate:X.Y.Z` and `:sha-<full-commit>` — maintenance.
4. It creates a **draft** release `vX.Y.Z`, with generated PR notes and an attached
   `release-manifest.json` recording the commit and both image digests.
5. Review and publish the draft in GitHub. Deploy explicitly using the manifest's
   digest references and the [VM instructions](../.infra/README.md).

Draft creation and generated notes use GitHub CLI's
[`gh release create`](https://cli.github.com/manual/gh_release_create).
The release workflow reuses the existing CI through
[`workflow_call`](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
CI stays read-only. Only the release job receives `contents: write` and
`packages: write`. The repository/organization must allow GitHub Actions to
create releases and publish GHCR packages; no personal token is required by
these workflows. No remote settings are changed by this commit.

Images initially target **linux/amd64**. For an ARM VM, extend the build platforms
before releasing. Local Docker builds use the local machine's architecture.
Version and SHA tags are human-readable references; **digests** are the immutable
deployment references. There is no `latest` deployment tag.

A partial failure can leave an image published without a draft. Rerunning the
same workflow at the same commit can finish that release; once a draft or tag
exists, the workflow refuses to overwrite it. Inspect any partial run before
retrying. Publishing a draft does not deploy the application or run migrations.

## Build and publish images from your computer

The local launcher follows Portail's `.bin/product` + product scripts + shared
submodule layout. It builds the **current working directory**, including
uncommitted code allowed by `.dockerignore`; no Git commit, tag, PR merge or
workflow run is required. Bash 4.4+ is required (Homebrew Bash on macOS).

```sh
# Preview the exact build targets, tags and labels without building or pushing:
.bin/product build:image 0.1.0-local.1 print

# Build both images and load them into your local Docker engine:
.bin/product build:image 0.1.0-local.1 load

# Authenticate, then build and publish both images from this checkout:
.bin/product docker:login
.bin/product release:build:local 0.1.0-local.1 push
```

The published references are `ghcr.io/la-fabrique-ai/studio:0.1.0-local.1` and
`ghcr.io/la-fabrique-ai/studio-migrate:0.1.0-local.1`. `build:image` accepts an
optional `app` or `migrate` target; both are built by default. `release:build:local`
is a convenience command using the same builder; without arguments it creates
a timestamped `X.Y.Z-local.YYYYMMDDHHMMSS` version and **loads locally**.

`docker:login` prompts for a GitHub username and a token (input is hidden, passed
to Docker via stdin). You can alternatively supply `GHCR_USERNAME` and
`GHCR_TOKEN` in the calling environment. Use a token authorized to publish to
La Fabrique's GHCR packages. Do not commit it in an env file or pass it as a
build argument. Publishing images creates the packages even without a GitHub
Release; set both packages to public in GitHub settings for anonymous pulls.

The numeric version base must match `package.json`. Local **pushes require a
prerelease suffix**, such as `-local.1`, so they cannot replace stable CI images.
Use a fresh version for each changed build (`-local.2`, etc.); registry tags can
be overwritten. No `latest` or SHA alias is published by these local scripts.
Labels record the source commit and whether the checkout has local changes;
the commit alone does not reproduce an image built from uncommitted code.

Builds default to `linux/amd64`, like CI. For native Apple Silicon testing:

```sh
PLATFORM=linux/arm64 .bin/product build:image 0.1.0-local.1 load
```

These commands publish **container images only**: they do not create a Git tag
or a GitHub Release, push source code, deploy, or modify the CI workflow.

Portail's `vault:resolve` and `sops-merge` scripts operate on encrypted
`.infra/env.*.yml` files and GPG recipients. Studio currently uses ignored `.env`
files, so those merge tools are not installed or enabled. The shared
`vault:edit` command is available but requires configuring Studio's own SOPS/GPG
keys and encrypted files first. No Portail vault, account or key is reused.

## CI scope

Pull requests and pushes to `main` run the existing checks plus Docker builds of
the `runner` and `migrate` targets, without registry publication. Database suites,
Playwright and deployment smoke tests remain separate. A green CI does not prove
a database upgrade or functional acceptance.

The first iteration intentionally omits Portail's moving WIP tag, release
candidates, GitLab orchestration, Tchap notifications and automatic deployments.
It provides the basic version → commit → images → release traceability.
