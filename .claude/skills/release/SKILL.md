---
name: release
description: Cutting a TokenDamper release — choosing the number, bumping the single version source, writing the CHANGELOG section, tagging, publishing the GitHub release, and handing npm publish to the user for 2FA. Use this skill whenever the task is to ship, release, tag, publish, or cut a version; whenever someone asks what the next version number should be or whether a change is major/minor/patch; and whenever main has landed work that npm does not yet have. Triggers on: cut a release, ship it, bump the version, publish to npm, tag, v1.6.0, what version should this be, release notes.
---

# Cutting a release

The number is decided by what shipped, the version has one source, and the npm publish is not
yours to run. Everything else is mechanical.

## Choosing the number

**The roadmap reserves no version numbers (DECISIONS §53).** A number is a fact about what
shipped, assigned at ship time. Four reservations in four releases were wrong, each for a
different reason. Do not take a number from `ROADMAP.md`, and do not renumber the chain to make
room for anything.

The rule this project actually applies, from v1.3.0, v1.4.0 and v1.5.0:

- **patch** — nothing observable changes for a user running the same command on the same input
- **minor** — *"nothing removed, but the same command over the same input emits different bytes"*.
  This is the usual answer here, including for pure bug fixes, because a reduction engine that
  reduces differently is a behavioural change even when the change is a fix.
- **major** — a capability that worked is gone or changed shape

**A setting that never took effect is not a capability.** When a knob was silently ignored and
now errors, nothing that worked stopped working — but it can still break someone's startup, so it
belongs at the top of the release notes rather than buried. Judge on "did something that worked
stop working", not "could anyone notice".

Say the number and the reasoning out loud before touching a file, and let the user confirm. This
is a judgement call with real consequences, not a lookup.

## What actually changes

`src/version.ts` is the **single source**:

```ts
export const TOKENDAMPER_VERSION = '1.5.0';
```

`CLI_ADAPTER_VERSION`, `MCP_ADAPTER_VERSION`, `SERVER_VERSION` and `config.appVersion` all derive
from it — do not edit them. `package.json` carries its own `version` field, so that one is a real
second edit; use `npm version <x.y.z> --no-git-tag-version`, which updates `package-lock.json`
too. Past release commits touched exactly:

```
src/version.ts  package.json  package-lock.json
CHANGELOG.md  CLAUDE.md  ROADMAP.md  docs/audit-remediation-status.md
```

The doc edits are not ceremony. `CLAUDE.md`'s "Where the project actually is" and the status
doc's header both state the current release; leaving them stale is how this project has
repeatedly ended up with a document confidently describing a build that no longer exists.

## The sequence

1. **Confirm the number with the user**, with reasoning.
2. **Branch.** Releases land through a PR like everything else — never commit to `main`.
3. **Bump** `src/version.ts`, then `npm version <x.y.z> --no-git-tag-version`.
4. **CHANGELOG** — promote `[Unreleased]` to `## [vX.Y.Z] - YYYY-MM-DD` and write a short lede
   saying what changed and what it cost. Keep the measured tables; they are the point.
5. **Docs** — update `CLAUDE.md`'s release line, the status doc header, and any ROADMAP row that
   now names a shipped thing.
6. **Verify, and read the output** — `npm run typecheck`, `npm run lint`, `npm test`,
   `npm run build`, then confirm the **built artifact** carries the new number.

   **There is no `--version` flag.** `tokendamper --version` prints usage, and the trace carries
   no `adapterVersion` either, so neither is a check. Three things do report it:

   ```bash
   node -e "console.log(require('./dist/src/version.js').TOKENDAMPER_VERSION)"   # the built constant
   node -e "console.log(require('./package.json').version)"                      # what npm publishes
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"1"}}}' \
     | node dist/src/cli/main.js mcp 2>/dev/null | head -1        # MCP serverInfo.version
   ```

   All three must agree. Read `dist/`, not `src/` — bumping the constant and shipping a stale
   `dist/` is a silent, plausible failure, and `src/version.ts` will look correct either way.
   Every past release commit states the test count and that the built CLI reports the new number.
7. **PR, CI, merge.**
8. **Tag and GitHub release** from merged `main`:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — <short phrase>"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z — <short phrase>" --notes-file <notes>
   ```
   Titles are a short phrase, not a summary — *"the target adheres"*, *"the dial binds"*, *"a
   comment narrates as well as instructs"*.
9. **Hand npm to the user.** See below.

## npm publish is the user's step

`npm publish` requires the user's 2FA one-time code. **Do not attempt it**; run the checks and
hand over a ready command.

**Say which directory to run it in, and say it every time.** The user's shell is usually the main
checkout, and releases are cut on a branch — often in a worktree. A main checkout that has not
pulled the merge still carries the *old* `package.json`, so `npm publish` there succeeds and
publishes the **previous** number over a tree that is not what that number was tagged from. This
has happened (v1.7.4: the publish ran in the un-pulled main checkout and put the security
remediation on the registry as **1.7.3**, 663 insertions away from the `v1.7.3` tag). Hand over
both commands, in order:

```bash
git pull origin main
```

```bash
npm publish
```

**And tell them to read the version in the banner before confirming the 2FA prompt.**
`prepublishOnly`’s first line is `> tokendamper@X.Y.Z prepublishOnly`, printed well before
anything irreversible — it is the last free check that the right number is going out, and it
costs one glance. A publish cannot be undone after 72 hours, and the version can never be
reused even then.

```bash
npm publish
```

`prepublishOnly` runs `clean → typecheck → lint → build → test` first, so a broken tree cannot
publish. Point out that this is the gate, and that it rebuilds `dist/` from scratch.

After they publish, `npm view tokendamper version` confirms what the registry actually serves —
worth checking rather than assuming, because a failed 2FA leaves everything else looking done.

## Things that have gone wrong here

- **`dist/` is what ships.** `package.json` `files` publishes `dist`, `test/fixtures/bench` and
  the docs. A stale `dist/` means the published bytes disagree with the tagged source; step 6
  exists for that.
- **The wrong *directory* is the same failure as a stale `dist/`, and step 6 does not catch it.**
  Step 6 verifies the artifact in the tree you are standing in. It cannot tell you the user will
  publish from a different one. v1.7.4 passed every check here — three version reporters agreeing,
  `npm pack --dry-run` read first, CI green on three Node versions — and then went out as 1.7.3,
  because the publish ran in a checkout that predated the merge. **Verifying the artifact and
  verifying that the publish will happen in that artifact’s directory are two checks.** This is
  invariant 10 pointed at the release: a green result from a tree nobody published.
- **Do not add a `format` script back.** DECISIONS §49 — it never passed, nothing invoked it, and
  making it pass meant rewriting the repository. `lint` is the style gate.
- **Line endings.** The repo is uniformly CRLF. A scripted edit to `CHANGELOG.md` or `CLAUDE.md`
  in default text mode flattens it to LF and produces a diff full of phantom changes. Check
  before committing — the `measure-corpus` skill has the one-liner.
- **The release notes are read by people deciding whether to upgrade.** Lead with what breaks or
  changes behaviour, then what was fixed. Measured tables beat adjectives.

## Before you start

Check what `main` has that the registry does not:

```bash
git log --oneline $(git describe --tags --abbrev=0)..main
npm view tokendamper version
```

If that list is long, the release notes have to be written from it rather than from memory — and
if anything in it is a defect users are currently hitting, say so in the notes.
