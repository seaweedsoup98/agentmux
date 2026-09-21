# Releasing agentmux to npm

## Important: package name

The unscoped npm package name `agentmux` is already owned by another project.
This repository publishes as `@jiho.ko/agentmux` while keeping the repository and CLI
command named `agentmux`.

Run:

```bash
npm run release:check
```

The release check also verifies that setup and native plugin bundles use the same
published package name.

## Initial publication

Version 0.1.0 has been published as `@jiho.ko/agentmux`.

PowerShell requires the scoped package argument to be quoted when typing commands
directly:

```powershell
npm view '@jiho.ko/agentmux' version
npx -y '@jiho.ko/agentmux@latest' --version
```

POSIX shells also accept the same quoted form, so documentation should prefer it.

## Configure trusted publishing after the first release

In npm package settings, add a GitHub Actions trusted publisher:

- GitHub owner: `seaweedsoup98`
- Repository: `agentmux`
- Workflow filename: `publish.yml`
- Allow direct `npm publish`

The workflow already has `id-token: write` and runs on GitHub-hosted Ubuntu with
Node 24. Future releases can then be published from **Actions → Publish npm package**
without storing a long-lived npm token.

Use `dry_run=true` first. Set it to false only for an intended release.

## Automatic releases from main

Publishing no longer requires pressing the **Run workflow** button for normal stable releases.

A push to `main` that changes `package.json` automatically runs
`.github/workflows/publish.yml`. The workflow publishes only when:

- `package.json.version` is a stable `x.y.z` version,
- that exact version is not already present on npm,
- the version is newer than the current npm `latest`, and
- `CHANGELOG.md` contains a matching `## x.y.z` section.

If the current version is already published, the workflow succeeds but skips the
publish step. Registry/network errors are treated as failures rather than as evidence
that a version is unpublished.

The manual **Run workflow** entry remains available for dry-run validation or
exceptional releases.

### Normal release flow

On a release branch:

```bash
npm version patch --no-git-tag-version
```

(or use `minor` / `major`). The npm `version` lifecycle automatically syncs
the Codex/Claude plugin manifests and Claude marketplace entry to the same version.
Then add the matching changelog section, run `npm run check`, and merge the
change into `main`.

After the merge:

```text
package.json version change on main
  -> Publish npm package workflow
  -> check/test/build/release validation
  -> npm registry version check
  -> npm publish through Trusted Publishing
```

No workflow button or npm login is required.

## Version release checklist

1. Bump `package.json.version`.
2. Add the matching `CHANGELOG.md` section.
3. Run the full CI suite.
4. Run real-provider E2E for the installed provider set when the runtime changed materially.
5. Merge to `main`; npm publishing starts automatically.
6. Verify a clean-machine install using the exact npm package name (quote scoped names in PowerShell).
7. Create the matching GitHub tag/release.
