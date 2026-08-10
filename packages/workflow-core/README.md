# botmux-workflow-core

Daemon-independent Workflow v3 contracts generated from Botmux's canonical
implementation. The package exposes the DAG schema, deterministic scheduler,
loop/revisit control, gate policy, and host runtime contracts. Authoring
surfaces such as host bindings use explicit subpath exports.

It deliberately does not export the Botmux daemon driver, Feishu cards,
ephemeral worker pool, PTY/session integration, or provider executors. A host
such as Botmux Desktop supplies those execution adapters itself.

## Exports

- `botmux-workflow-core/schema`
- `botmux-workflow-core/engine`
- `botmux-workflow-core/control`
- `botmux-workflow-core/gate-policy`
- `botmux-workflow-core/host-contract`
- `botmux-workflow-core/runtime`
- `botmux-workflow-core/events`
- `botmux-workflow-core/host-bindings`

The root export is the reviewed daemon-independent runtime surface. Authoring
APIs are intentionally available only through their explicit subpaths. Every
export provides ESM, CommonJS, and TypeScript declaration targets.

`runtime` is the daemon-independent Node runtime. The host injects agent
execution, manifest validation, human-gate resolution, and host-action
executors. `runWorkflow` is an alias of `runPortableWorkflow`; neither starts
the Botmux daemon nor imports Botmux session or Feishu adapters. A successful
terminal outcome includes `finalOutputs` for every sink (manifest/output
directory, validated manifest snapshot/hash, and optional `result.json`
path/hash/parsed snapshot). Recovery code can derive the same projection with
`await readPortableWorkflowFinalOutputs(dag, runDir, validateManifest)`
without parsing the internal journal. Returned paths are canonical and bound
to the owning attempt; consumers should use the returned snapshots or verify
the hashes again before reopening a path that another process can mutate.

The first drive writes an immutable, normalized run snapshot under
`baseDir/dag.runId`. Reusing that location resumes only when both the DAG and
every execution profile exactly match the snapshot; model, executor, working
directory, profile identity, or adapter-data drift fails before dispatch.
Because execution profiles are durable run metadata, `adapterData` must contain
stable non-secret references rather than credentials.

Saved Workflow persistence and authoring are intentionally not exported from
this core package: the current Botmux implementation still owns Node filesystem
and legacy runtime contracts. It can move to a separate authoring package once
that boundary is independently clean.

## Local Desktop consumption

Build a real npm tarball from the Botmux checkout:

```bash
cd /path/to/botmux
pnpm workflow-core:pack
```

The command prints the absolute `.tgz` path. Install that artifact from the
Desktop project with an exact dependency:

```bash
cd /path/to/botmux-clients/desktop
pnpm add --save-exact /absolute/path/to/botmux/packages/workflow-core/.packs/botmux-workflow-core-0.0.0.tgz
```

CI can install this package directly from a pinned Botmux commit and package
subdirectory. The package `prepare` script builds the missing `dist` files:

```json
{
  "dependencies": {
    "botmux-workflow-core": "github:deepcoldy/botmux#FULL_COMMIT_SHA&path:/packages/workflow-core"
  }
}
```

When adding it from a shell, quote the spec because `&` is a shell operator:

```bash
pnpm add --save-exact 'github:deepcoldy/botmux#FULL_COMMIT_SHA&path:/packages/workflow-core'
```

Always pin the full commit SHA. Do not depend on the whole Botmux package or
deep-import `botmux/dist/workflows/v3/*`; that couples Desktop to daemon and
native runtime dependencies.

For a published release, use an exact version such as:

```json
{
  "dependencies": {
    "botmux-workflow-core": "3.8.0"
  }
}
```

Desktop should bundle this package into its Electron main-process output rather
than adding it to the unpacked runtime dependency closure.
