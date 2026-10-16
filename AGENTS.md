# ClipDock agent rules

## Testability first

For code, feature, and behavior changes, design around a runnable test seam. Develop in the smallest deterministic environment that exercises the changed behavior; use real Resolve, OS, or provider environments only for boundaries that cannot be represented faithfully in-process. Every non-trivial change must leave the smallest relevant automated check behind.

## Agent proves, user checks the residue

The agent proves every change itself before reporting it; the user verifies only the residue no agent-runnable check reaches. Climb this ladder as far as the change reaches, and report which rungs ran:

1. `npm test` and `npm run check`: logic, file safety, engines, tooling.
2. Preview (`npm run preview`, open `/?preview=ready`; the bare `/` has no host API by design): drive the panel in the browser for every renderer change, exercising the flow the fix touched.
3. `npm run test:resolve:headless`: the Resolve scripting API surface.
4. `npm run test:resolve:e2e`: ClipDock's real transfer, status and media-prep code against Resolve `-nogui` in a throwaway `ClipDock-E2E-` project, read back from Resolve. Default gate for anything on the download → prepare → import → timeline chain.

Rungs 3 and 4 start a real Resolve Studio; run them only while Resolve and `fuscript` are closed, and keep their active-process refusal, project-name and ownership checks intact. When the user's Resolve is open, ask them to close it rather than skipping the rung.

The residue is `WorkflowIntegration.node`, panel loading in the Resolve GUI, native drag, how the panel renders inside Resolve, and the administrator install. Hand it to the user as a short list naming exactly what to look at. A headless or preview pass is never live panel or visual evidence.

## Live Resolve UI verification

For changes that reach the residue:

1. Run the relevant check, then install with `npm run install:plugin`. This command builds before copying.
2. If macOS requires elevation, run `npm run build` before the administrator install. Never install an unverified existing `dist/`.
3. Run `npm run verify:installed`. It verifies the completed build identity, every shipped file, and the Resolve-native module.
4. Restart Resolve completely; Workflow Integration files may remain loaded until restart.
5. Claim that Resolve shows the current UI only after the installed artifact matches and the restarted panel is read back. A repository build or preview alone is not live Resolve evidence.
