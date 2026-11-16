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

## CI scope

Pull requests and pushes to `main` run the existing checks plus Docker builds of
the `runner` and `migrate` targets, without registry publication. Database suites,
Playwright and deployment smoke tests remain separate. A green CI does not prove
a database upgrade or functional acceptance.

The first iteration intentionally omits Portail's moving WIP tag, release
candidates, GitLab orchestration, Tchap notifications and automatic deployments.
It provides the basic version → commit → images → release traceability.
