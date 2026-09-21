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

## Version release checklist

1. Update version/changelog.
2. Run the full CI suite.
3. Run real-provider E2E for the installed provider set.
4. Run the publish workflow with `dry_run=true`.
5. Publish.
6. Verify a clean-machine install using the exact npm package name (quote scoped names in PowerShell).
7. Create the matching GitHub tag/release.
