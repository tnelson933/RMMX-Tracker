---
name: better-sqlite3 native build
description: How to install and compile better-sqlite3 in this pnpm workspace
---

## The rule

Adding `better-sqlite3` to a workspace package requires two steps beyond `pnpm add`:
1. Add `better-sqlite3` to the `onlyBuiltDependencies` list in `pnpm-workspace.yaml`
2. Run `pnpm rebuild better-sqlite3` to trigger native compilation

## Why

pnpm 10 blocks all build scripts by default for security. better-sqlite3 requires
native compilation (C++ binding → `.node` file). Without the allowlist entry, pnpm
installs the JS files but skips `node-gyp rebuild`, and `require('better-sqlite3')`
fails with "Could not locate the bindings file".

## How to apply

When any workspace package needs better-sqlite3:
- Confirm `better-sqlite3` is in `onlyBuiltDependencies` in `pnpm-workspace.yaml`
- After `pnpm install`, run `pnpm rebuild better-sqlite3`
- The `.node` binary lands in the pnpm central store and is shared across packages
- In esbuild bundles, externalize with `external: ["*.node", "better-sqlite3"]`
  plus the banner that adds `globalThis.require = createRequire(import.meta.url)`

## tsconfig note

Leaf server artifacts should inherit `moduleResolution: bundler` from `tsconfig.base.json`
(do NOT override with `NodeNext`). NodeNext requires explicit `.js` extensions on
relative imports; bundler mode doesn't. The api-server and local-server both use bundler.
