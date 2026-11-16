/**
 * Core file operations for the offline handoff bundle.
 *
 * A bundle is a plain directory (no compression, no dependencies) that carries:
 *   manifest.json      what was packed, where it came from
 *   sessions/          <DSH_HOME>/sessions copied verbatim
 *   workspace/NN-name/ one copy per packed project directory
 *   attachments/       <DSH_HOME>/attachments copied verbatim
 *   plugin/            a copy of this plugin, so the other machine can install it
 *
 * Nothing here touches the network. Import never deletes anything.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const BUNDLE_FORMAT = 1

/** Directory names never copied out of a workspace. */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'obj',
  'bin',
  '.vs',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.idea',
  '.gradle',
]

const SESSION_FILE_RE = /^session(\.[A-Za-z0-9]+)?\.jsonl(\.zstd)?$/

/**
 * Replace a filesystem path with the exact project-directory key the JSONL
 * session backend uses: separators become one `-`, unsafe code units become
 * `~XXXX`, leading dashes are trimmed, and the slug is wrapped in `--`.
 * Mirrors `projectKey` in @deepseek-ai/dsh-session-persistence-jsonl.
 * @param {string} cwd - absolute project path.
 * @returns {string} one safe directory segment.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Encode a session id as one safe path segment (mirrors the backend helper).
 * @param {string} raw - session id.
 * @returns {string} safe segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Resolve the harness home and the roots this plugin reads and writes.
 * @param {object} config - plugin config.
 * @returns {{home: string, sessionsRoot: string, attachmentsRoot: string, exportRoot: string}} resolved paths.
 */
export function resolvePaths(config = {}) {
  const home = config.dshHome
    || process.env.DSH_HOME
    || path.join(os.homedir(), '.dsh')
  return {
    home,
    sessionsRoot: config.sessionsRoot || path.join(home, 'sessions'),
    attachmentsRoot: config.attachmentsRoot || path.join(home, 'attachments'),
    exportRoot: config.exportRoot || path.join(os.homedir(), 'dsh-handoff'),
  }
}

/**
 * Read the first JSON object of a session log. zstd stores the header in its
 * own first frame, so a plain whole-file decompress returns exactly that line.
 * @param {string} file - absolute log path.
 * @returns {object|null} the `{type:'session',...}` header, or null.
 */
export function readSessionHeader(file) {
  let buf
  try {
    const stat = fs.statSync(file)
    if (stat.size > 256 * 1024 * 1024) return null
    buf = fs.readFileSync(file)
  } catch {
    return null
  }
  let text
  try {
    text = file.endsWith('.zstd')
      ? zlib.zstdDecompressSync(buf).toString('utf8')
      : buf.toString('utf8')
  } catch {
    return null
  }
  const line = text.split('\n', 1)[0].trim()
  if (line.length === 0) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && parsed.type === 'session' ? parsed : null
  } catch {
    return null
  }
}

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Return the offset just past the zstd frame that starts at `start`.
 * Walks the frame header and block list exactly as RFC 8878 defines them, so a
 * concatenation of frames can be split without decoding the payloads.
 * @param {Buffer} buf - file bytes.
 * @param {number} start - offset of the frame magic.
 * @returns {number} offset of the next frame (or the end of the buffer).
 */
export function frameEnd(buf, start) {
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame at offset ${start}`)
  }
  let p = start + 4
  const fhd = buf[p]
  p += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) p += 1 // window descriptor
  p += dictFlag === 3 ? 4 : dictFlag // dictionary id
  if (fcsFlag === 0) p += singleSegment ? 1 : 0
  else if (fcsFlag === 1) p += 2
  else if (fcsFlag === 2) p += 4
  else p += 8
  for (;;) {
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 0) p += size // raw
    else if (type === 1) p += 1 // RLE
    else if (type === 2) p += size // compressed
    else throw new Error('reserved zstd block type')
    if (last) break
  }
  if (checksum) p += 4
  if (p > buf.length) throw new Error('truncated zstd frame')
  return p
}

/**
 * Split a concatenated zstd file into its frames.
 * @param {Buffer} buf - file bytes.
 * @returns {Array<{start: number, end: number}>} frame boundaries in order.
 */
export function splitFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const end = frameEnd(buf, offset)
    frames.push({ start: offset, end })
    offset = end
  }
  return frames
}

/**
 * Rewrite the session header's `cwd` in place, keeping every later frame
 * byte-identical. The header lives alone in the first frame, so only that frame
 * is re-encoded.
 *
 * A Session log whose header names a directory this machine does not have makes
 * the workspace and session registries fail to activate, which surfaces as
 * unrelated-looking `service-unavailable` errors. Importing therefore always
 * rewrites the header to the directory the workspace was actually restored to.
 *
 * @param {Buffer} buf - original log bytes.
 * @param {string} newCwd - absolute project path on this machine.
 * @returns {{buffer: Buffer, changed: boolean}} patched bytes.
 */
export function rewriteSessionCwd(buf, newCwd) {
  const frames = splitFrames(buf)
  if (frames.length === 0) throw new Error('session log has no zstd frame')
  const firstRaw = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end))
  const lines = firstRaw.toString('utf8').split('\n')
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw new Error('session log header is not JSON')
  }
  if (header.type !== 'session') throw new Error('session log does not start with a session header')
  if (header.cwd === newCwd) {
    return { buffer: buf, changed: false }
  }
  header.cwd = newCwd
  lines[0] = JSON.stringify(header)
  const newFirst = zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
  const rest = buf.subarray(frames[0].end)
  return { buffer: Buffer.concat([newFirst, rest]), changed: true }
}

/**
 * Verify a rewritten log still starts with the expected header and that its tail
 * frame decodes — the same integrity check the backend performs on read.
 * @param {Buffer} buf - log bytes to verify.
 * @param {string} expectedCwd - cwd the header must carry.
 * @returns {boolean} whether the log is safely readable.
 */
export function verifySessionLog(buf, expectedCwd) {
  try {
    const frames = splitFrames(buf)
    if (frames.length === 0) return false
    const first = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
    const header = JSON.parse(first.split('\n', 1)[0])
    if (header.type !== 'session' || header.cwd !== expectedCwd) return false
    const lastFrame = frames[frames.length - 1]
    zlib.zstdDecompressSync(buf.subarray(lastFrame.start, lastFrame.end))
    return true
  } catch {
    return false
  }
}

/**
 * Enumerate session directories below a sessions root.
 * @param {string} sessionsRoot - root holding the project/session directory tree.
 * @returns {Array<{projectKey: string, dir: string, id: string, files: string[], bytes: number, header: object|null}>}
 */
export function enumerateSessions(sessionsRoot) {
  const sessions = []
  let projects
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(sessionsRoot, project.name)
    let entries
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(projectPath, entry.name)
      let files = []
      let bytes = 0
      try {
        files = fs.readdirSync(dir).filter(name => {
          try {
            return fs.statSync(path.join(dir, name)).isFile()
          } catch {
            return false
          }
        })
        for (const name of files) bytes += fs.statSync(path.join(dir, name)).size
      } catch {
        continue
      }
      const logs = files.filter(name => SESSION_FILE_RE.test(name))
        .map(name => path.join(dir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      const header = logs.length > 0 ? readSessionHeader(logs[0]) : null
      sessions.push({
        projectKey: project.name,
        dir,
        id: header?.id ?? entry.name,
        files,
        bytes,
        header,
      })
    }
  }
  return sessions
}

/**
 * Recursively size a tree while honouring excludes and skipping symlinks.
 * @param {string} dir - directory to measure.
 * @param {Set<string>} excludes - names to skip.
 * @param {number} limit - stop counting past this many bytes.
 * @returns {{bytes: number, files: number, truncated: boolean}}
 */
export function measureTree(dir, excludes, limit = Number.MAX_SAFE_INTEGER) {
  let bytes = 0
  let files = 0
  let truncated = false
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += fs.statSync(full).size
        } catch { /* vanished */ }
        if (bytes > limit) {
          truncated = true
          return { bytes, files, truncated }
        }
      }
    }
  }
  return { bytes, files, truncated }
}

/**
 * Copy one tree, applying excludes and never following symlinks.
 * @param {string} src - source directory.
 * @param {string} dest - destination directory.
 * @param {Set<string>} excludes - names to skip.
 * @param {boolean} overwrite - replace existing destination files.
 * @returns {{files: number, skipped: number}}
 */
export function copyTree(src, dest, excludes, overwrite, onFile) {
  fs.mkdirSync(dest, { recursive: true })
  let files = 0
  let skipped = 0
  const stack = [[src, dest]]
  while (stack.length > 0) {
    const [from, to] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(from, { withFileTypes: true })
    } catch {
      continue
    }
    fs.mkdirSync(to, { recursive: true })
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push([source, target])
      } else if (entry.isFile()) {
        if (!overwrite && fs.existsSync(target)) {
          skipped += 1
          if (onFile) onFile()
          continue
        }
        try {
          fs.copyFileSync(source, target)
          files += 1
        } catch {
          skipped += 1
        }
        if (onFile) onFile()
      }
    }
  }
  return { files, skipped }
}

/**
 * Timestamped bundle directory name, sortable and collision-free per second.
 * @param {Date} now - current time.
 * @returns {string} `handoff-YYYYMMDD-HHmmss`.
 */
export function bundleName(now) {
  const p = n => String(n).padStart(2, '0')
  return `handoff-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * Reserve a bundle directory, adding a suffix when two exports land in the same
 * second so one never writes into another's folder.
 * @param {string} root - export root.
 * @param {string} name - preferred bundle name.
 * @returns {{dir: string, name: string}} the directory actually created.
 */
export function reserveBundleDir(root, name) {
  let candidate = name
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const dir = path.join(root, candidate)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      return { dir, name: candidate }
    }
    candidate = `${name}-${attempt}`
  }
  const fallback = `${name}-${Date.now().toString(36)}`
  fs.mkdirSync(path.join(root, fallback), { recursive: true })
  return { dir: path.join(root, fallback), name: fallback }
}

/**
 * Pack sessions, attachments and workspaces into a new bundle directory.
 * @param {object} options - resolved paths, config and a logger.
 * @returns {object} export summary.
 */
export function exportBundle({ config = {}, log = () => {}, onProgress } = {}) {
  const paths = resolvePaths(config)
  const now = new Date()
  const reserved = reserveBundleDir(paths.exportRoot, bundleName(now))
  const name = reserved.name
  const dir = reserved.dir

  const excludes = new Set([...(config.exclude || []), ...DEFAULT_EXCLUDES])
  const maxBytes = Number(config.maxWorkspaceBytes ?? 2 * 1024 * 1024 * 1024)

  log(`scanning ${paths.sessionsRoot}`)
  const sessions = enumerateSessions(paths.sessionsRoot)

  // Plan every workspace first so the progress bar has a stable total.
  const wanted = new Set()
  for (const session of sessions) {
    if (config.includeSessionWorkspaces !== false && session.header?.cwd) {
      wanted.add(session.header.cwd)
    }
  }
  for (const extra of config.workspaces || []) if (typeof extra === 'string' && extra) wanted.add(extra)

  const plans = []
  let index = 0
  for (const source of wanted) {
    index += 1
    const base = path.basename(source) || `workspace-${index}`
    const folder = `${String(index).padStart(2, '0')}-${base.replace(/[^A-Za-z0-9._-]/g, '_')}`
    if (!fs.existsSync(source)) {
      plans.push({ source, folder, missing: true, files: 0, bytes: 0, copy: false })
      continue
    }
    const size = measureTree(source, excludes, maxBytes)
    if (size.truncated) {
      plans.push({ source, folder, missing: false, files: 0, bytes: 0, copy: false, skippedReason: 'over maxWorkspaceBytes' })
      continue
    }
    plans.push({ source, folder, missing: false, files: size.files, bytes: size.bytes, copy: true })
  }

  const attachmentBytes = config.includeAttachments !== false && fs.existsSync(paths.attachmentsRoot)
    ? measureTree(paths.attachmentsRoot, new Set())
    : { files: 0, bytes: 0 }

  const totalFiles = sessions.reduce((n, session) => n + session.files.length, 0)
    + plans.reduce((n, plan) => n + plan.files, 0)
    + attachmentBytes.files

  let done = 0
  let lastReport = 0
  const report = (phase) => {
    if (!onProgress) return
    const stamp = Date.now()
    if (done < totalFiles && stamp - lastReport < 100) return
    lastReport = stamp
    onProgress({ phase, done, total: totalFiles })
  }
  const tick = () => {
    done += 1
    report('打包中')
  }

  report('扫描会话')

  // Sessions verbatim, preserving the backend's project directory keys.
  let sessionBytes = 0
  for (const session of sessions) {
    const target = path.join(dir, 'sessions', session.projectKey, encodeSegment(session.id))
    fs.mkdirSync(target, { recursive: true })
    for (const file of session.files) {
      const from = path.join(session.dir, file)
      fs.copyFileSync(from, path.join(target, file))
      sessionBytes += fs.statSync(from).size
      tick()
    }
  }

  // Workspaces.
  const workspaces = []
  for (const plan of plans) {
    if (!plan.copy) {
      workspaces.push({
        source: plan.source,
        folder: null,
        missing: plan.missing,
        skippedReason: plan.skippedReason,
        files: 0,
        bytes: 0,
      })
      continue
    }
    const copied = copyTree(plan.source, path.join(dir, 'workspace', plan.folder), excludes, true, tick)
    workspaces.push({ source: plan.source, folder: `workspace/${plan.folder}`, files: copied.files, bytes: plan.bytes })
  }

  // Attachments (content-addressed; copying is safe and repeatable).
  let attachments = { files: 0, bytes: 0 }
  if (attachmentBytes.files > 0) {
    const copied = copyTree(paths.attachmentsRoot, path.join(dir, 'attachments'), new Set(), true, tick)
    attachments = { files: copied.files, bytes: attachmentBytes.bytes }
  }
  report('写入清单')

  const manifest = {
    format: BUNDLE_FORMAT,
    kind: 'dsh-handoff',
    createdAt: now.toISOString(),
    host: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    bundle: name,
    sessions: sessions.map(session => ({
      id: session.id,
      cwd: session.header?.cwd ?? null,
      projectKey: session.projectKey,
      files: session.files,
      bytes: session.bytes,
    })),
    workspaces,
    attachments,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  fs.writeFileSync(path.join(dir, 'README.txt'), bundleReadme(manifest), 'utf8')

  return {
    dir,
    name,
    sessions: sessions.length,
    sessionBytes,
    workspaces,
    attachments,
  }
}

/** Content-addressed attachment references carried inside Session events. */
const ATTACHMENT_REF = /sha256:([0-9a-f]{64})/g

/**
 * Collect the attachment digests one Session log references.
 * Every frame is decoded separately because zstd concatenation is not a stream.
 * @param {string} file - session log path.
 * @returns {Set<string>} referenced sha256 digests.
 */
export function collectAttachmentIds(file) {
  const ids = new Set()
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return ids
  }
  if (buf.length === 0) return ids
  if (!file.endsWith('.zstd')) {
    for (const match of buf.toString('utf8').matchAll(ATTACHMENT_REF)) ids.add(match[1])
    return ids
  }
  for (const frame of splitFrames(buf)) {
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(ATTACHMENT_REF)) ids.add(match[1])
  }
  return ids
}

/**
 * Copy only the attachment objects a Session references, keeping the store's
 * own layout so an import writes them back where the backend expects them.
 * @param {string} attachmentsRoot - `<DSH_HOME>/attachments`.
 * @param {Set<string>} ids - referenced digests.
 * @param {string} bundleDir - destination bundle.
 * @returns {{files: number, bytes: number}} copied totals.
 */
export function copyReferencedAttachments(attachmentsRoot, ids, bundleDir, onFile) {
  let files = 0
  let bytes = 0
  const v1 = path.join(attachmentsRoot, 'v1')
  if (ids.size === 0 || !fs.existsSync(v1)) return { files, bytes }
  for (const folder of ['objects', 'file-objects']) {
    for (const id of ids) {
      const source = path.join(v1, folder, id.slice(0, 2), id)
      if (!fs.existsSync(source)) continue
      const dest = path.join(bundleDir, 'attachments', 'v1', folder, id.slice(0, 2), id)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(source, dest)
      files += 1
      bytes += fs.statSync(source).size
      if (onFile) onFile()
    }
  }
  const filesRoot = path.join(v1, 'files')
  if (fs.existsSync(filesRoot)) {
    for (const prefix of fs.readdirSync(filesRoot)) {
      const prefixDir = path.join(filesRoot, prefix)
      let entries
      try {
        if (!fs.statSync(prefixDir).isDirectory()) continue
        entries = fs.readdirSync(prefixDir)
      } catch {
        continue
      }
      for (const digest of entries) {
        if (!ids.has(digest)) continue
        const source = path.join(prefixDir, digest)
        const dest = path.join(bundleDir, 'attachments', 'v1', 'files', prefix, digest)
        const copied = copyTree(source, dest, new Set(), true, onFile)
        files += copied.files
        bytes += measureTree(source, new Set()).bytes
      }
    }
  }
  return { files, bytes }
}

/**
 * Pack one Session, its workspace and only its referenced attachments.
 * The manifest keeps the same shape as a full bundle, plus `scope: 'session'`,
 * so the existing import path restores it unchanged.
 * @param {object} options - config, session id and a logger.
 * @returns {object} export summary.
 */
export function exportSessionBundle({ config = {}, sessionId, log = () => {}, onProgress } = {}) {
  const paths = resolvePaths(config)
  const wanted = String(sessionId ?? '').trim()
  if (wanted.length === 0) throw new Error('缺少会话 id')
  const sessions = enumerateSessions(paths.sessionsRoot)
  const session = sessions.find(item => item.id === wanted)
  if (!session) throw new Error(`找不到会话：${wanted}`)

  const now = new Date()
  const reserved = reserveBundleDir(paths.exportRoot, bundleName(now))
  const name = reserved.name
  const dir = reserved.dir

  const excludes = new Set([...(config.exclude || []), ...DEFAULT_EXCLUDES])
  const maxBytes = Number(config.maxWorkspaceBytes ?? 2 * 1024 * 1024 * 1024)

  const workspacePlan = session.header?.cwd && fs.existsSync(session.header.cwd)
    ? measureTree(session.header.cwd, excludes, maxBytes)
    : { files: 0, bytes: 0, truncated: false }
  const totalFiles = session.files.length
    + (session.header?.cwd ? workspacePlan.files : 0)

  let done = 0
  let lastReport = 0
  const report = (phase) => {
    if (!onProgress) return
    const stamp = Date.now()
    if (done < totalFiles && stamp - lastReport < 100) return
    lastReport = stamp
    onProgress({ phase, done, total: totalFiles })
  }
  const tick = () => {
    done += 1
    report('打包中')
  }
  report('扫描会话')

  let sessionBytes = 0
  const sessionDir = path.join(dir, 'sessions', session.projectKey, encodeSegment(session.id))
  fs.mkdirSync(sessionDir, { recursive: true })
  for (const file of session.files) {
    const from = path.join(session.dir, file)
    fs.copyFileSync(from, path.join(sessionDir, file))
    sessionBytes += fs.statSync(from).size
    tick()
  }

  const workspaces = []
  const source = session.header?.cwd
  if (source && fs.existsSync(source)) {
    const base = path.basename(source) || 'workspace'
    const folder = `01-${base.replace(/[^A-Za-z0-9._-]/g, '_')}`
    const size = workspacePlan
    if (size.truncated) {
      workspaces.push({ source, folder: null, missing: false, skippedReason: 'over maxWorkspaceBytes', files: 0, bytes: 0 })
    } else {
      const copied = copyTree(source, path.join(dir, 'workspace', folder), excludes, true, tick)
      workspaces.push({ source, folder: `workspace/${folder}`, files: copied.files, bytes: size.bytes })
    }
  } else if (source) {
    workspaces.push({ source, folder: null, missing: true, files: 0, bytes: 0 })
  }

  let attachments = { files: 0, bytes: 0, mode: 'referenced' }
  if (config.includeAttachments !== false) {
    const logFile = session.files
      .filter(file => /\.jsonl(\.zstd)?$/.test(file))
      .map(file => path.join(session.dir, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    let ids = new Set()
    if (logFile) {
      try {
        ids = collectAttachmentIds(logFile)
      } catch (error) {
        log(`attachment scan failed: ${error?.message ?? error}`)
      }
    }
    const referenced = copyReferencedAttachments(paths.attachmentsRoot, ids, dir)
    if (referenced.files > 0 || ids.size > 0) {
      attachments = { ...referenced, mode: 'referenced' }
    } else if (fs.existsSync(paths.attachmentsRoot)) {
      const copied = copyTree(paths.attachmentsRoot, path.join(dir, 'attachments'), new Set(), true)
      attachments = { files: copied.files, bytes: measureTree(paths.attachmentsRoot, new Set()).bytes, mode: 'all' }
    }
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    kind: 'dsh-handoff',
    scope: 'session',
    sessionId: session.id,
    createdAt: now.toISOString(),
    host: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    bundle: name,
    sessions: [{
      id: session.id,
      cwd: session.header?.cwd ?? null,
      projectKey: session.projectKey,
      files: session.files,
      bytes: session.bytes,
    }],
    workspaces,
    attachments,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'README.txt'), bundleReadme(manifest), 'utf8')

  return { dir, name, sessions: 1, sessionBytes, workspaces, attachments, scope: 'session' }
}

/**
 * Human-readable package guide written next to the manifest.
 * @param {object} manifest - bundle manifest.
 * @returns {string} plain-text instructions.
 */
function bundleReadme(manifest) {
  const lines = [
    'DSH handoff bundle / DSH 交接包',
    '',
    `created: ${manifest.createdAt}`,
    `host:    ${manifest.host}`,
    `sessions: ${manifest.sessions.length}`,
    '',
    '在一台装有 dsh-handoff 插件的电脑上：',
    '',
    '1. 安装插件（只需一次）：把本包里的 plugin 文件夹',
    '   （或整个包）交给 Harness 的「插件 → 添加插件」，选择该目录。',
    '2. 输入 /handoff import 并回车。默认导入 exportRoot 中最新的一包；',
    '   也可以 /handoff import <包名> 指定。',
    '3. 重启 DSH，会话与工作区即可使用。',
    '',
    '目标机器上的工作区路径与本机不同时，先在该插件配置里设置',
    'targetWorkspace（见插件 README），再执行导入。',
    '',
    `session files: ${manifest.sessions.reduce((n, s) => n + s.files.length, 0)}`,
    `attachments:   ${manifest.attachments.files} files`,
  ]
  return lines.join('\n') + '\n'
}

/**
 * List an export folder's bundles, newest first.
 * @param {object} config - plugin config.
 * @returns {Array<{name: string, dir: string, manifest: object|null}>}
 */
export function listBundles(config = {}) {
  const { exportRoot } = resolvePaths(config)
  let entries
  try {
    entries = fs.readdirSync(exportRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const bundles = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('handoff-')) continue
    const dir = path.join(exportRoot, entry.name)
    let manifest = null
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch { /* incomplete bundle */ }
    bundles.push({ name: entry.name, dir, manifest })
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name)).reverse()
}

/**
 * Resolve one directory into the bundle it names. Accepts the bundle itself,
 * the folder that holds it (picking the newest `handoff-*` child), or a plain
 * name inside the export root — so an import can come from a USB folder.
 * @param {string} candidate - bundle directory, parent directory, or name.
 * @returns {{dir: string, name: string, manifest: object}|null} the bundle, or null.
 */
export function pickBundleDir(candidate) {
  let stat
  try {
    stat = fs.statSync(candidate)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null
  const manifestPath = path.join(candidate, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    const dir = candidate
    return { dir, name: path.basename(dir), manifest: readManifest(manifestPath) }
  }
  // The operator picked the folder that contains the bundle(s).
  let children = []
  try {
    children = fs.readdirSync(candidate, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('handoff-'))
      .map(entry => path.join(candidate, entry.name))
      .filter(dir => fs.existsSync(path.join(dir, 'manifest.json')))
      .sort()
  } catch {
    return null
  }
  if (children.length === 0) return null
  const dir = children[children.length - 1]
  return { dir, name: path.basename(dir), manifest: readManifest(path.join(dir, 'manifest.json')) }
}

/**
 * Read a bundle manifest without throwing.
 * @param {string} manifestPath - absolute path.
 * @returns {object|null} parsed manifest.
 */
function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Locate the bundle an operator named: an absolute or export-relative path
 * first, then a bundle name inside the export root, then the newest bundle.
 * @param {object} config - plugin config.
 * @param {string} name - bundle path or name.
 * @returns {{dir: string, name: string, manifest: object|null}|null} the bundle.
 */
export function locateBundle(config, name) {
  const paths = resolvePaths(config)
  const raw = String(name ?? '').trim()
  if (raw) {
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(paths.exportRoot, raw)
    const picked = pickBundleDir(absolute)
    if (picked) {
      if (!picked.manifest) throw new Error(`不是有效的交接包（manifest.json 无法解析）：${picked.dir}`)
      return picked
    }
    const byName = listBundles(config).find(bundle => bundle.name === raw || bundle.dir === raw)
    if (byName) return byName
    throw new Error(`找不到交接包：${raw}`)
  }
  const newest = listBundles(config)[0]
  return newest ?? null
}

/**
 * Restore a bundle into this machine's harness home and workspaces.
 * Existing files are kept unless `overwrite` is true; nothing is deleted.
 * @param {object} options - config, optional bundle name, logger.
 * @returns {object} import summary.
 */
export function importBundle({ config = {}, name = '', log = () => {} } = {}) {
  const paths = resolvePaths(config)
  const chosen = locateBundle(config, name)
  if (!chosen) {
    throw new Error(`no bundle found in ${paths.exportRoot}`)
  }
  if (!chosen.manifest) {
    throw new Error(`bundle ${chosen.name} has no readable manifest.json`)
  }
  const manifest = chosen.manifest
  const overwrite = config.overwrite === true

  // Map each packed source path to where it should land here.
  const mapped = new Map()
  const workResults = []
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : []
  for (const entry of workspaces) {
    if (!entry.folder) {
      workResults.push({ source: entry.source, target: null, files: 0, skipped: 0, reason: entry.missing ? 'source missing' : entry.skippedReason })
      continue
    }
    let target
    if (config.targetWorkspace) {
      target = workspaces.filter(w => w.folder).length > 1
        ? path.join(config.targetWorkspace, path.basename(entry.source))
        : config.targetWorkspace
    } else if (fs.existsSync(entry.source)) {
      target = entry.source
    } else {
      // The recorded path belongs to another machine (different user name,
      // drive, or OS layout). Restore into a writable place instead of failing.
      target = path.join(paths.home, 'dsh-workspaces', path.basename(entry.source))
    }
    mapped.set(entry.source, target)
    const copied = copyTree(path.join(chosen.dir, entry.folder), target, new Set(), overwrite)
    workResults.push({ source: entry.source, target, files: copied.files, skipped: copied.skipped })
    log(`workspace ${entry.source} -> ${target}: ${copied.files} files`)
  }

  // Sessions: every imported log must name a directory this machine really has.
  // A stale `cwd` inside a stored log stops the workspace and session registries
  // from activating, which the client reports as "service unavailable".
  const sessionResults = []
  const sessions = Array.isArray(manifest.sessions) ? manifest.sessions : []
  for (const entry of sessions) {
    const recordedCwd = typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : null
    let targetCwd = recordedCwd
    if (recordedCwd && mapped.has(recordedCwd)) {
      targetCwd = mapped.get(recordedCwd)
    } else if (recordedCwd && !fs.existsSync(recordedCwd)) {
      sessionResults.push({
        id: entry.id,
        target: null,
        copied: 0,
        skipped: 0,
        repaired: 0,
        reason: `工作区未打包且本机不存在：${recordedCwd}`,
      })
      continue
    }
    const targetRoot = targetCwd ? projectKey(targetCwd) : entry.projectKey
    const target = path.join(paths.sessionsRoot, targetRoot, encodeSegment(entry.id))
    fs.mkdirSync(target, { recursive: true })
    let copied = 0
    let skipped = 0
    let repaired = 0
    for (const file of entry.files || []) {
      const from = path.join(chosen.dir, 'sessions', entry.projectKey, encodeSegment(entry.id), file)
      const to = path.join(target, file)
      if (!fs.existsSync(from)) { skipped += 1; continue }
      const isLog = /\.jsonl(\.zstd)?$/.test(file)
      const needsRewrite = Boolean(targetCwd && recordedCwd && targetCwd !== recordedCwd && isLog)

      if (fs.existsSync(to) && !overwrite) {
        // Existing file: repair a stale header instead of leaving it poisoned.
        if (isLog) {
          const current = readSessionHeader(to)
          if (targetCwd && current && current.cwd !== targetCwd) {
            try {
              const { buffer, changed } = rewriteSessionCwd(fs.readFileSync(to), targetCwd)
              if (changed && verifySessionLog(buffer, targetCwd)) {
                fs.writeFileSync(to, buffer)
                repaired += 1
                log(`repaired stale cwd in ${to}`)
                continue
              }
            } catch (error) {
              log(`repair failed for ${to}: ${error?.message ?? error}`)
            }
          }
        }
        skipped += 1
        continue
      }

      if (!needsRewrite) {
        fs.copyFileSync(from, to)
        copied += 1
        continue
      }
      try {
        const { buffer } = rewriteSessionCwd(fs.readFileSync(from), targetCwd)
        if (!verifySessionLog(buffer, targetCwd)) throw new Error('rewritten log failed verification')
        fs.writeFileSync(to, buffer)
        copied += 1
      } catch (error) {
        skipped += 1
        log(`skipped session ${entry.id}: ${error?.message ?? error}`)
      }
    }
    sessionResults.push({ id: entry.id, target, copied, skipped, repaired, cwd: targetCwd })
  }

  // Attachments: content-addressed files merge cleanly.
  let attachments = { files: 0, skipped: 0 }
  const attachmentsDir = path.join(chosen.dir, 'attachments')
  if (fs.existsSync(attachmentsDir)) {
    const copied = copyTree(attachmentsDir, paths.attachmentsRoot, new Set(), overwrite)
    attachments = { files: copied.files, skipped: copied.skipped }
  }

  return {
    bundle: chosen.name,
    dir: chosen.dir,
    sessions: sessionResults,
    workspaces: workResults,
    attachments,
  }
}
