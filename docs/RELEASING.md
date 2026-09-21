# Releasing agentmux to npm

## Important: package name

The unscoped npm package name `agentmux` is already owned by another project.
The repository and CLI may continue to be named `agentmux`, but `package.json.name`
must use a publishable npm package name before the first release.

Run:

```bash
npm run release:check
```

The release check also verifies that setup and native plugin bundles use the same
published package name.

## First publication

npm trusted publishing cannot be configured for a package that does not exist yet.
Therefore the first publication is an explicit maintainer action.

1. Confirm the npm account:

   ```bash
   npm whoami
   ```

2. Set the final package name in `package.json` and update all
   `<package>@latest` launch references.
3. Run:

   ```bash
   npm run check
   npm run release:check
   npm pack --dry-run
   ```

4. Log in if needed:

   ```bash
   npm login
   ```

5. Publish version 0.1.0:

   ```bash
   npm publish
   ```

For a scoped package, `publishConfig.access=public` is already set.

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
6. Verify a clean-machine install using the exact npm package name.
7. Create the matching GitHub tag/release.
