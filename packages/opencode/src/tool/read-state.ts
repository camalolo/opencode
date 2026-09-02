import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionID } from "../session/schema"

// Per-session record of files the model has read, enforcing read-before-edit/write.
// Process-local by design: after a server restart the model must read again, which the
// error message tells it to do.
const state = new Map<string, Set<string>>()

export function markRead(sessionID: SessionID, filePath: string) {
  const key = FSUtil.normalizePath(filePath)
  const files = state.get(sessionID)
  if (files) files.add(key)
  else state.set(sessionID, new Set([key]))
}

export function hasRead(sessionID: SessionID, filePath: string) {
  return state.get(sessionID)?.has(FSUtil.normalizePath(filePath)) ?? false
}
