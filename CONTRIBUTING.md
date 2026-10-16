# Contributing to ClipDock

Keep each pull request focused on one topic. Describe the behavior it changes
and the checks you ran. Follow the style of the surrounding code.

## Set up

Use Node.js 18 or newer:

```sh
git clone https://github.com/Srcanesen/ClipDock.git
cd ClipDock
npm install
```

For provider downloads, install the tools listed in the
[README requirements](README.md#requirements). They are not bundled.

## Before a pull request

Run both checks:

```sh
npm test
npm run check
```

For renderer changes, run `npm run preview` and exercise the changed flow at the
printed URL with `/?preview=ready`. The bare `/` has no host API.
Preview uses sample data; it does not prove integration with Resolve.

Bug fixes should include a focused regression test in `test/bugfix-*.test.mjs`.
Reproduce the failure first, then confirm the same check passes with the fix.
Assert an expected value or observable effect. Non-trivial behavior changes
should also leave an automated check that exercises the changed behavior.

## Resolve checks

Run the relevant Resolve checks for scripting API changes. Run the E2E check
for changes to download, preparation, import or timeline behavior:

```sh
npm run build
npm run test:resolve:headless
npm run test:resolve:e2e
```

These checks currently support macOS. Resolve Studio must be installed and closed,
with no fuscript running. The checks start Resolve without a GUI and refuse to
run if an existing Resolve or fuscript process is active.
The headless scripting check is read-only. The E2E check creates and deletes
its own throwaway `ClipDock-E2E-` project, with ownership checks before mutations.

Report any checks you could not run. Native drag, panel loading and rendering
inside Resolve still need GUI verification when those boundaries change.

## License

By submitting a contribution, you agree to license it under the project's
[MIT License](LICENSE). Keep third-party license notices with their assets.
