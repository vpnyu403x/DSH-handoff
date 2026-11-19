/**
 * Register imported Sessions with the live Workspace registry.
 *
 * A Session log dropped into `<DSH_HOME>/sessions` is invisible to the sidebar
 * on its own: every grouping surface renders Workspace membership from the
 * durable Workspace registry (`<DSH_HOME>/storages/workspace.json`, or the
 * `workspaceRegistry` service in newer builds). This module attaches each
 * imported Session to the Workspace that owns its canonical cwd, creating that
 * Workspace record when the directory is not registered yet.
 *
 * Two strategies, in order:
 *   1. the live `workspaceRegistry` service — the authoritative write path, so
 *      DSH persists the change itself and no file is raced;
 *   2. a direct `storages/workspace.json` patch — only when the service is
 *      absent (older or differently composed builds). That path is a fallback
 *      and needs a DSH restart to be read.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Resolve the Workspace registry service without assuming the composition has it.
 * @param {object} ctx - host context.
 * @returns {object|undefined} the registry, when mounted.
 */
function registryOf(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('workspaceRegistry') ?? undefined
  } catch {
    /* service lookup is optional */
  }
  return ctx?.workspaceRegistry
}

/**
 * Normalize a path the same way the registry does, when possible.
 * @param {string} value - absolute path.
 * @returns {string} canonical path, or the resolved spelling when realpath fails.
 */
function canonical(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Attach imported Sessions through the live registry.
 * @param {object} registry - `workspaceRegistry` service.
 * @param {Array<{id: string, cwd?: string}>} sessions - imported Sessions.
 * @param {(line: string) => void} log - progress sink.
 * @returns {Promise<{mode: string, attached: object[], failed: object[]}|null>} outcome, null when unusable.
 */
async function viaRegistry(registry, sessions, log) {
  const canResolve = typeof registry.resolveByPath === 'function'
  const canCreate = typeof registry.create === 'function'
  const canUnarchive = typeof registry.unarchiveSession === 'function'
  if (!canResolve && !canCreate) return null

  const attached = []
  const failed = []
  for (const session of sessions) {
    try {
      const cwd = typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : undefined
      if (cwd === undefined) {
        failed.push({ id: session.id, reason: '会话头里没有可用的 cwd' })
        continue
      }
      let workspace = canResolve ? await registry.resolveByPath(cwd) : undefined
      if (workspace === undefined && canCreate) {
        workspace = await registry.create(cwd, path.basename(cwd))
      }
      if (workspace === undefined) {
        failed.push({ id: session.id, reason: `没有登记 ${cwd} 的工作区` })
        continue
      }
      const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []
      if (canUnarchive && archived.includes(session.id)) {
        await registry.unarchiveSession(session.id)
      }
      await workspace.attachSession(session.id)
      attached.push({ id: session.id, workspace: workspace.path ?? cwd })
      log(`[handoff] 已登记 ${session.id} → ${workspace.path ?? cwd}`)
    } catch (error) {
      failed.push({ id: session.id, reason: error?.message ?? String(error) })
      log(`[handoff] 登记 ${session.id} 失败：${error?.message ?? error}`)
    }
  }
  return { mode: 'registry', attached, failed }
}

/**
 * Patch `storages/workspace.json` directly (fallback when the service is absent).
 * @param {string} home - DSH home directory.
 * @param {Array<{id: string, cwd?: string}>} sessions - imported Sessions.
 * @param {(line: string) => void} log - progress sink.
 * @returns {{mode: string, attached: object[], failed: object[], file: string}} outcome.
 */
function viaFile(home, sessions, log) {
  const file = path.join(home, 'storages', 'workspace.json')
  const attached = []
  const failed = []
  if (!fs.existsSync(file)) {
    return {
      mode: 'none',
      attached,
      failed: sessions.map(session => ({ id: session.id, reason: '没有 workspace.json，且没有工作区服务' })),
      file,
    }
  }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return {
      mode: 'none',
      attached,
      failed: sessions.map(session => ({ id: session.id, reason: `workspace.json 无法解析：${error?.message ?? error}` })),
      file,
    }
  }

  const global = doc.global ?? (doc.global = { initialized: true, workspaceIds: [] })
  const tables = doc.tables ?? (doc.tables = {})
  const workspaces = tables.workspaces ?? (tables.workspaces = {})
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : (global.workspaceIds = [])
  const archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : (global.archivedSessionIds = [])

  const backup = `${file}.handoff-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(file, backup)
  log(`[handoff] workspace.json 已备份：${backup}`)

  const now = new Date().toISOString()
  for (const session of sessions) {
    try {
      if (typeof session.cwd !== 'string' || session.cwd.length === 0) {
        failed.push({ id: session.id, reason: '会话头里没有可用的 cwd' })
        continue
      }
      const cwd = canonical(session.cwd)
      let workspaceId = Object.keys(workspaces).find(id => canonical(workspaces[id].path) === cwd)
      if (workspaceId === undefined) {
        workspaceId = randomUUID()
        workspaces[workspaceId] = {
          path: cwd,
          title: path.basename(cwd),
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        }
        order.unshift(workspaceId)
      }
      const record = workspaces[workspaceId]
      record.sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : []
      if (!record.sessionIds.includes(session.id)) record.sessionIds.unshift(session.id)
      record.updatedAt = now
      const archivedAt = archived.indexOf(session.id)
      if (archivedAt !== -1) archived.splice(archivedAt, 1)
      attached.push({ id: session.id, workspace: cwd })
      log(`[handoff] 已写入 workspace.json：${session.id} → ${cwd}`)
    } catch (error) {
      failed.push({ id: session.id, reason: error?.message ?? String(error) })
    }
  }

  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return { mode: 'file', attached, failed, file }
}

/**
 * Make imported Sessions visible on grouping surfaces.
 *
 * Never throws: a failed registration must not fail an import that already
 * restored the files. The outcome is reported to the caller for display.
 *
 * @param {object} ctx - host context (may be partial).
 * @param {Array<{id: string, cwd?: string, target?: string|null}>} sessions - import results.
 * @param {{home?: string, log?: (line: string) => void}} [options] - home override and log sink.
 * @returns {Promise<{mode: string, attached: object[], failed: object[]}>} registration outcome.
 */
export async function registerImportedSessions(ctx, sessions, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const home = options.home
    || process.env.DSH_HOME
    || path.join(os.homedir(), '.dsh')

  const usable = (Array.isArray(sessions) ? sessions : []).filter(session =>
    session && typeof session.id === 'string' && session.id.startsWith('session-') && session.target !== null)

  if (usable.length === 0) return { mode: 'none', attached: [], failed: [] }

  const registry = registryOf(ctx)
  if (registry !== undefined) {
    try {
      const outcome = await viaRegistry(registry, usable, log)
      if (outcome !== null) return outcome
    } catch (error) {
      log(`[handoff] 工作区服务登记失败，改用 workspace.json：${error?.message ?? error}`)
    }
  }

  try {
    return viaFile(home, usable, log)
  } catch (error) {
    return {
      mode: 'none',
      attached: [],
      failed: usable.map(session => ({ id: session.id, reason: error?.message ?? String(error) })),
    }
  }
}
