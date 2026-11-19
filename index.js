/**
 * dsh-handoff — offline handoff bundles for DSH.
 *
 * `/handoff export` packs every Session, every Session workspace, all
 * attachments, and a copy of this plugin into one dated folder.
 * `/handoff import` restores such a folder on another machine.
 *
 * No network access, no third-party dependencies, no background daemons.
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  copyTree,
  exportBundle,
  exportSessionBundle,
  importBundle,
  listBundles,
  resolvePaths,
} from './lib/core.js'
import { registerImportedSessions } from './lib/register.js'

export const name = 'handoff'
export const inject = ['commands']

const USAGE = [
  '/handoff export [目录]            打包全部会话、附件、工作区',
  '/handoff export-session <会话id> [目录]  只打包指定会话及其附件',
  '/handoff import [路径或包名]      还原最新（或指定）的交接包',
  '/handoff list                   列出导出目录里的交接包',
  '/handoff status                 显示当前路径与包数量',
].join('\n')

/**
 * Register the `/handoff` command.
 *
 * Registration is wrapped so a missing or changed Host service can never take
 * the profile composition down with it: a failed `apply` on this machine would
 * otherwise surface as unrelated services being unavailable.
 *
 * @param {object} ctx - host context with the human-command registry.
 * @param {object} config - plugin config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const settings = config || {}
  const logger = safeLogger(ctx)

  const definition = {
    definitionId: '@local/dsh-handoff',
    name: 'handoff',
    description: 'Pack or restore Sessions, attachments and workspaces offline',
    input: { hint: 'export [dir] | export-session <id> [dir] | import [bundle] | list | status' },
    handler: async ({ rawInput }) => {
      const text = String(rawInput ?? '').trim()
      const space = text.indexOf(' ')
      const verb = (space === -1 ? text : text.slice(0, space)).toLowerCase()
      const rest = space === -1 ? '' : text.slice(space + 1).trim()

      try {
        if (verb === '' || verb === 'help') return { kind: 'success', text: USAGE }
        if (verb === 'status') return { kind: 'success', text: statusText(settings) }
        if (verb === 'list') return { kind: 'success', text: listText(settings) }
        if (verb === 'export') {
          const result = exportTo(settings, rest, logger)
          return { kind: 'success', text: exportText(result) }
        }
        if (verb === 'export-session') {
          const tail = rest.trim()
          if (tail.length === 0) {
            return { kind: 'error', text: '用法：/handoff export-session <会话id> [目录]' }
          }
          const split = tail.indexOf(' ')
          const id = split === -1 ? tail : tail.slice(0, split)
          const dir = split === -1 ? '' : tail.slice(split + 1).trim()
          const result = exportTo(settings, dir, logger, id)
          return { kind: 'success', text: exportText(result) }
        }
        if (verb === 'import') {
          const result = importBundle({ config: settings, name: rest, log: line => logger.info?.(line) })
          // Files alone are not enough on builds whose sidebar renders Workspace
          // membership from the durable registry: attach every restored Session
          // before reporting success. Registration failures never fail the import.
          const registration = await registerImportedSessions(ctx, result.sessions, { home: resolvePaths(settings).home, log: line => logger.info?.(line) })
          return { kind: 'success', text: importText(result, registration) }
        }
        return { kind: 'error', text: `未知子命令：${verb}\n\n${USAGE}` }
      } catch (error) {
        logger.error?.(error)
        return { kind: 'error', text: `handoff ${verb || 'help'} 失败：${error?.message ?? error}` }
      }
    },
  }

  try {
    const register = () => ctx.commands.register(definition)
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, 'handoff: /handoff command')
    } else {
      register()
    }
  } catch (error) {
    logger.error?.(`[handoff] 命令注册失败，插件不可用：${error?.message ?? error}`)
  }

  try {
    registerExportRoute(ctx, settings, logger)
  } catch (error) {
    logger.warn?.(`[handoff] 导出路由不可用：${error?.message ?? error}`)
  }
}

/** Absolute registration path of the browser export route. */
export const EXPORT_ROUTE = '/api/handoff.export'

/** Absolute registration path of the progress poll route. */
export const PROGRESS_ROUTE = '/api/handoff.progress'

/** Absolute registration path of the availability probe. */
export const PING_ROUTE = '/api/handoff.ping'

/** Running and finished export jobs, keyed by job id. */
const JOBS = new Map()

/** How long a settled job stays pollable. */
const JOB_TTL_MS = 10 * 60 * 1000

/**
 * Register the browser-callable routes used by the right-click menu.
 * The routes are mounted only when the connection service exists, so a
 * composition without a Web carrier keeps the rest of the plugin working.
 * @param {object} ctx - host context.
 * @param {object} settings - plugin config.
 * @param {object} logger - host logger.
 */
function registerExportRoute(ctx, settings, logger) {
  const mount = (connection) => {
    try {
      const api = connection?.fetch
      if (!api || typeof api.register !== 'function') {
        logger.warn?.('[handoff] connection.fetch is unavailable; skipping the export route')
        return
      }

      const register = (path, handler) => api.register({
        path,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: handler,
      })

      const disposers = []
      disposers.push(register(PING_ROUTE, async () => jsonResponse({
        ok: true,
        version: pluginVersion(),
        exportRoot: resolvePaths(settings).exportRoot,
      }, 200)))

      disposers.push(register(EXPORT_ROUTE, async (request) => {
        let target = ''
        let sessionId = ''
        let async = false
        try {
          const query = new URL(request.url).searchParams
          target = normalizeTarget(query.get('target') ?? '')
          sessionId = query.get('session') ?? ''
          async = query.get('job') === '1'
        } catch { /* malformed URL */ }

        if (async) {
          try {
            const jobId = startJob(settings, target, sessionId, logger)
            return jsonResponse({ ok: true, jobId }, 200)
          } catch (error) {
            logger.error?.(error)
            return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
          }
        }

        try {
          const result = exportTo(settings, target, logger, sessionId)
          return jsonResponse(summaryOf(result), 200)
        } catch (error) {
          logger.error?.(error)
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      }))

      disposers.push(register(PROGRESS_ROUTE, async (request) => {
        let jobId = ''
        try {
          jobId = new URL(request.url).searchParams.get('job') ?? ''
        } catch { /* malformed URL */ }
        const job = JOBS.get(jobId)
        if (!job) return jsonResponse({ ok: false, error: '导出任务不存在或已过期' }, 404)
        return jsonResponse({ ok: true, ...job }, 200)
      }))

      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch { /* already gone */ }
          }
        }, 'handoff: browser routes')
      }
    } catch (error) {
      logger.warn?.(`[handoff] 导出路由注册失败：${error?.message ?? error}`)
    }
  }

  // Mount eagerly when the service is already up, otherwise wait for it. Both
  // paths are guarded so a carrier-less composition keeps the command working.
  let direct
  try {
    direct = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    direct = undefined
  }
  if (direct && direct.fetch && typeof direct.fetch.register === 'function') {
    mount(direct)
    return
  }
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['connection'], (scope) => {
        mount(scope.connection ?? scope.get?.('connection'))
      })
      return
    } catch (error) {
      logger.warn?.(`[handoff] ctx.inject failed: ${error?.message ?? error}`)
    }
  }
  logger.warn?.('[handoff] connection service unavailable; the right-click export is disabled')
}

/**
 * Run one export in the background and publish its progress.
 * @param {object} settings - plugin config.
 * @param {string} target - absolute destination.
 * @param {string} sessionId - optional Session to pack alone.
 * @param {object} logger - host logger.
 * @returns {string} job id.
 */
function startJob(settings, target, sessionId, logger) {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job = {
    state: 'running',
    phase: '准备中',
    done: 0,
    total: 0,
    startedAt: Date.now(),
    result: null,
    error: null,
  }
  JOBS.set(id, job)

  setTimeout(() => {
    try {
      const result = exportTo(settings, target, logger, sessionId, (progress) => {
        job.phase = progress.phase
        job.done = progress.done
        job.total = progress.total
      })
      job.state = 'done'
      job.phase = '完成'
      job.done = job.total
      job.result = summaryOf(result)
    } catch (error) {
      logger.error?.(error)
      job.state = 'error'
      job.error = String(error?.message ?? error)
    } finally {
      setTimeout(() => JOBS.delete(id), JOB_TTL_MS).unref?.()
    }
  }, 0)

  return id
}

/**
 * Flatten an export summary into the wire shape the browser reads.
 * @param {object} result - export summary.
 * @returns {object} JSON-safe summary.
 */
function summaryOf(result) {
  return {
    ok: true,
    scope: result.scope ?? 'all',
    dir: result.dir,
    name: result.name,
    sessions: result.sessions,
    workspaces: result.workspaces.filter(item => item.folder).length,
    attachments: result.attachments.files,
  }
}

/**
 * Accept a `file://` URL from a picker that reports URIs, and trim the value.
 * @param {string} value - raw target from the query string.
 * @returns {string} filesystem-shaped path.
 */
function normalizeTarget(value) {
  let raw = String(value ?? '').trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim()
  }
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw)
    } catch {
      return raw.slice('file://'.length)
    }
  }
  return raw
}

/**
 * Report the installed plugin version without reading package.json at runtime.
 * @returns {string} version string.
 */
function pluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return String(manifest.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * Build a JSON response without assuming a global `Response.json`.
 * @param {object} body - JSON body.
 * @param {number} status - HTTP status.
 * @returns {Response} the response.
 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Export to an explicit folder, or to the configured default when none is given.
 * The browser menu passes a user-picked directory here, plus a Session id when
 * only the clicked Session should be packed.
 * @param {object} settings - plugin config.
 * @param {string} target - absolute destination directory, or ''.
 * @param {object} logger - host logger.
 * @param {string} sessionId - optional Session to pack alone.
 * @returns {object} export summary.
 */
export function exportTo(settings, target, logger = console, sessionId = '', onProgress) {
  const dir = target ? validateTarget(target, settings) : resolvePaths(settings).exportRoot
  fs.mkdirSync(dir, { recursive: true })
  const config = { ...settings, exportRoot: dir }
  const log = line => logger.info?.(line)
  const result = sessionId
    ? exportSessionBundle({ config, sessionId, log, onProgress })
    : exportBundle({ config, log, onProgress })
  attachPlugin(result.dir, logger)
  return result
}

/**
 * Accept only an absolute destination outside the harness data directories.
 * A bad path is a user error and must not be able to copy `.dsh` into itself.
 * @param {string} target - user-supplied directory.
 * @param {object} settings - plugin config.
 * @returns {string} the resolved absolute directory.
 */
export function validateTarget(target, settings) {
  const raw = normalizeTarget(target)
  if (raw.length === 0) throw new Error('目标文件夹为空')
  if (!path.isAbsolute(raw)) throw new Error(`目标必须是绝对路径：${raw}`)
  const resolved = path.resolve(raw)
  const paths = resolvePaths(settings)
  const guarded = [paths.sessionsRoot, paths.attachmentsRoot, paths.home]
  for (const forbidden of guarded) {
    const base = path.resolve(forbidden).toLowerCase()
    const candidate = resolved.toLowerCase()
    if (candidate === base || candidate.startsWith(base + path.sep)) {
      throw new Error(`不能导出到 Harness 数据目录内部：${resolved}`)
    }
  }
  return resolved
}

/**
 * Resolve the Host logger without assuming the service is mounted.
 * @param {object} ctx - host context.
 * @returns {object} a logger-like object.
 */
function safeLogger(ctx) {
  try {
    const logger = ctx?.logger
    if (logger && typeof logger === 'object' && typeof logger.info === 'function') return logger
  } catch { /* service absent in this composition */ }
  return console
}

/**
 * Copy this plugin into the bundle so the other machine can install it from there.
 * @param {string} bundleDir - finished bundle directory.
 * @param {object} logger - host logger.
 */
function attachPlugin(bundleDir, logger) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    copyTree(here, path.join(bundleDir, 'plugin'), new Set(['node_modules', '.git']), true)
  } catch (error) {
    logger.warn?.(`handoff: could not copy the plugin into the bundle: ${error?.message ?? error}`)
  }
}

/**
 * Render `/handoff status`.
 * @param {object} settings - plugin config.
 * @returns {string} status text.
 */
function statusText(settings) {
  const paths = resolvePaths(settings)
  const bundles = listBundles(settings)
  return [
    `导出目录：${paths.exportRoot}`,
    `会话目录：${paths.sessionsRoot}`,
    `附件目录：${paths.attachmentsRoot}`,
    `已有交接包：${bundles.length} 个`,
    bundles[0] ? `最新：${bundles[0].name}` : '最新：（无）',
    `工作区映射：${settings.targetWorkspace ? `导入到 ${settings.targetWorkspace}` : '按包内原路径还原'}`,
  ].join('\n')
}

/**
 * Render `/handoff list`.
 * @param {object} settings - plugin config.
 * @returns {string} bundle list text.
 */
function listText(settings) {
  const bundles = listBundles(settings)
  if (bundles.length === 0) {
    const { exportRoot } = resolvePaths(settings)
    return `导出目录里还没有交接包：${exportRoot}\n先运行 /handoff export。`
  }
  const lines = [`共 ${bundles.length} 个交接包：`]
  for (const bundle of bundles.slice(0, 20)) {
    const manifest = bundle.manifest
    const sessions = manifest?.sessions?.length ?? 0
    const workspaces = (manifest?.workspaces ?? []).filter(item => item.folder).length
    const attachments = manifest?.attachments?.files ?? 0
    lines.push(`${bundle.name}  会话 ${sessions} · 工作区 ${workspaces} · 附件 ${attachments}`)
  }
  if (bundles.length > 20) lines.push(`…… 还有 ${bundles.length - 20} 个`)
  return lines.join('\n')
}

/**
 * Render a successful export.
 * @param {object} result - export summary.
 * @returns {string} display text.
 */
function exportText(result) {
  const lines = [
    `已打包：${result.name}`,
    `位置：${result.dir}`,
    `会话：${result.sessions} 个`,
  ]
  const packed = result.workspaces.filter(item => item.folder)
  for (const item of packed) lines.push(`工作区：${item.source}（${item.files} 个文件）`)
  const skipped = result.workspaces.filter(item => !item.folder)
  for (const item of skipped) {
    lines.push(`跳过：${item.source}（${item.missing ? '目录不存在' : item.skippedReason}）`)
  }
  lines.push(`附件：${result.attachments.files} 个文件`)
  lines.push('')
  lines.push('把整个文件夹拷到另一台电脑，安装包内的 plugin 目录后运行 /handoff import。')
  return lines.join('\n')
}

/**
 * Render a successful import.
 * @param {object} result - import summary.
 * @param {{mode?: string, attached?: object[], failed?: object[]}} [registration] - workspace registration outcome.
 * @returns {string} display text.
 */
function importText(result, registration) {
  const written = result.sessions.filter(item => item.copied > 0).length
  const repaired = result.sessions.filter(item => item.repaired > 0).length
  const skipped = result.sessions.filter(item => item.target === null || (item.copied === 0 && item.repaired === 0)).length
  const lines = [
    `已导入：${result.bundle}`,
    `会话：写入 ${written} 个，修复 ${repaired} 个，跳过 ${skipped} 个`,
  ]
  for (const item of result.sessions) {
    if (item.target === null) lines.push(`  跳过 ${item.id}：${item.reason}`)
    else if (item.repaired > 0) lines.push(`  修复 ${item.id}：工作目录已改为 ${item.cwd}`)
  }
  for (const item of result.workspaces) {
    if (item.target) lines.push(`工作区：${item.source} → ${item.target}（${item.files} 个文件，跳过 ${item.skipped}）`)
    else lines.push(`工作区：${item.source} 跳过（${item.reason ?? '未知原因'}）`)
  }
  lines.push(`附件：${result.attachments.files} 个文件（跳过 ${result.attachments.skipped}）`)
  lines.push('')

  const attached = registration?.attached?.length ?? 0
  const failed = registration?.failed?.length ?? 0
  if (attached > 0) {
    lines.push(`已登记到工作区：${attached} 个会话${failed > 0 ? `（失败 ${failed} 个）` : ''}`)
    for (const item of registration.attached.slice(0, 10)) lines.push(`  ${item.id} → ${item.workspace}`)
  } else if (failed > 0) {
    lines.push(`未能登记到工作区：${failed} 个`)
    for (const item of registration.failed.slice(0, 10)) lines.push(`  ${item.id}：${item.reason}`)
  }
  if (registration?.mode === 'file') {
    lines.push('会话已写入 workspace.json（已自动备份），重启 DSH 后出现在会话列表。')
  } else if (attached > 0) {
    lines.push('重启 DSH 后，导入的会话会出现在会话列表中。')
  } else {
    lines.push('重启 DSH 后如果仍看不到会话，请运行 /handoff status 检查工作区映射。')
  }
  const moved = result.workspaces.some(item => item.target && item.target !== item.source)
  if (moved) {
    lines.push('会话里的工作目录已自动改成新位置，可以直接继续对话。')
  }
  return lines.join('\n')
}
