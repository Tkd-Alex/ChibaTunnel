#!/usr/bin/env node
// ─── cli.ts ───
//
// Thin launcher. Spawns Electron with the harness boot script and forwards flags.
// Usage:
//   chiba-test map                       — inventory every channel and show what the app registered
//   chiba-test test [--tier=readonly]    — run end-to-end tests up to a tier
//   chiba-test test --tier=spend --mnemonic="..."   — include on-chain spend tier (throwaway wallet!)
//
// Tiers (lowest→highest): ui, readonly, local, privileged, spend.
// Default tier is readonly — safe everywhere.

import { spawn } from 'child_process'
import * as path from 'path'

function findElectron(): string {
  // Resolve the electron binary shipped with the parent app.
  // chiba-testing/dist/cli.js → repo root is ../../
  const root = path.resolve(__dirname, '..', '..')
  // electron exports the path to its binary when required.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(root, 'node_modules', 'electron')) as string
  } catch {
    return 'electron'
  }
}

function main(): void {
  const [, , cmd = 'map', ...rest] = process.argv
  if (!['map', 'test'].includes(cmd)) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command '${cmd}'. Use: map | test`)
    process.exit(2)
  }

  const boot = path.resolve(__dirname, 'boot.js')
  const electron = findElectron()
  const args = [boot, `--mode=${cmd}`, ...rest]

  const child = spawn(electron, args, {
    stdio: 'inherit',
    env: { ...process.env, CHIBA_TEST: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to launch Electron harness:', err)
    process.exit(1)
  })
}

main()
