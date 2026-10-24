# Releasing

1. Update the version in `package.json` and `deno.json`.
2. Run the tests and builds. Check CI on Linux, macOS, and Windows, including
   browser tests and Node 26 FFI when affected.
3. If native code changed, rebuild and test the supported prebuilds with the
   native workflows.
4. Run **Publish npm package** with `dry_run: true`. Review the package contents
   and results. This workflow builds JavaScript, but doesn't rebuild native
   prebuilds for every platform.
5. Publish with `dry_run: false` when ready. npm needs the `NPM_TOKEN` repository
   secret. JSR is published separately; there is no JSR workflow here.
6. Tag the released commit as `v<version>` and create a GitHub Release. Include
   changes, migration notes, known limitations, and links to the published
   npm and JSR versions.

Package publication doesn't create a GitHub Release automatically. For historical
releases, find the matching source commit before adding a tag or release notes.
