// ─── registry.ts ───
//
// Captures every ipcMain.handle(channel, fn) the app registers, so the harness
// can invoke the *real* handler — the exact function ipcRenderer.invoke would
// trigger — with synthetic args. This is the heart of "reuse, never re-implement":
// we never copy handler logic, we record the live handlers and call them.
//
// The shim must be installed BEFORE the app's main bundle is required, so that
// registerIpcHandlers() lands in our map instead of the untouched ipcMain.

import { ipcMain, IpcMainInvokeEvent } from 'electron'

export type CapturedHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>

/** channel → the live handler function registered by the app. */
const handlers = new Map<string, CapturedHandler>()

/** Order of registration, for stable map output. */
const order: string[] = []

let installed = false

/**
 * Patches ipcMain.handle so every (channel, fn) pair is recorded here while
 * still being registered on the real ipcMain (harmless — nothing invokes it
 * over a real IPC bridge in headless mode). Idempotent.
 */
export function installCapture(): void {
  if (installed) return
  installed = true

  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, fn: CapturedHandler) => {
    if (!handlers.has(channel)) order.push(channel)
    handlers.set(channel, fn)
    // Keep the real registration too, so the app behaves identically.
    return originalHandle(channel, fn as never)
  }) as typeof ipcMain.handle
}

/** All captured channel names, in registration order. */
export function capturedChannels(): string[] {
  return [...order]
}

export function hasChannel(channel: string): boolean {
  return handlers.has(channel)
}

/**
 * Invokes a captured handler exactly as ipcRenderer.invoke would, with a
 * synthetic IpcMainInvokeEvent (handlers in this app never read the event,
 * but we pass a minimal stub for safety). Returns whatever the handler returns.
 *
 * Throws if the channel was never registered.
 */
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`Channel not registered: ${channel}`)
  const fakeEvent = {
    sender: { id: -1 },
    frameId: -1,
    processId: -1,
  } as unknown as IpcMainInvokeEvent
  return fn(fakeEvent, ...args)
}
