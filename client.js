/**
 * Browser half of dsh-handoff.
 *
 * Right-clicking a Session exports this Session, or every Session, into a folder
 * chosen in the OS chooser.
 *
 * Transport order, with a visible trail at every step:
 *   1. the Host `/handoff …` command over the app's own RPC channel
 *   2. the Host HTTP route as a fallback
 *   3. a console error + toast when both fail
 *
 * The progress dialog is mounted in `shell.overlay`; if that slot is missing the
 * toast still reports start, success and failure, so a gesture is never silent.
 *
 * Loaded by the Web module loader; `id` must equal the package name.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Keep in sync with package.json; logged so the running client is identifiable. */
    const VERSION = '0.9.3'

    const EXPORT_ROUTE = 'api/handoff.export'

    /** One module-level dialog store shared by every menu row. */
    const store = { value: null, listeners: new Set() }

    /**
     * Publish the next dialog state.
     * @param {object|null} next - open dialog state, or null to hide.
     */
    function publish(next) {
      store.value = next
      try {
        if (typeof globalThis.__handoffProbe === 'function') globalThis.__handoffProbe(next)
      } catch { /* a probe must never break the dialog */ }
      for (const listener of [...store.listeners]) {
        try {
          listener(next)
        } catch (error) {
          console.error('[handoff] dialog listener failed', error)
        }
      }
    }

    /**
     * Subscribe a component to the dialog store.
     * @returns {object|null} the current state.
     */
    function useDialogState() {
      const [value, setValue] = React.useState(store.value)
      React.useEffect(() => {
        const listener = next => setValue(next)
        store.listeners.add(listener)
        setValue(store.value)
        return () => { store.listeners.delete(listener) }
      }, [])
      return value
    }

    /** Component-local animation: an indeterminate bar without a global stylesheet. */
    const ANIMATION = '@keyframes handoff-bar { 0% { left: -35%; } 100% { left: 100%; } }'

    const styles = {
      backdrop: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      },
      card: {
        width: 440, maxWidth: '90vw', background: '#1f2023', color: '#e8e8ea',
        borderRadius: 12, padding: '20px 22px', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        font: '14px/1.6 system-ui, "Segoe UI", sans-serif',
      },
      title: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
      track: { position: 'relative', height: 8, background: 'rgba(255,255,255,0.12)', borderRadius: 999, overflow: 'hidden' },
      fill: { position: 'absolute', top: 0, bottom: 0, width: '35%', borderRadius: 999, background: '#3b6ef5' },
      full: { position: 'absolute', inset: 0, borderRadius: 999, background: '#3b6ef5' },
      detail: { marginTop: 10, color: 'rgba(232,232,234,0.78)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
      error: { marginTop: 10, color: '#ff8a80', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
      actions: { marginTop: 16, display: 'flex', justifyContent: 'flex-end' },
      button: {
        background: '#3b6ef5', color: '#fff', border: 'none', borderRadius: 8,
        padding: '6px 16px', cursor: 'pointer', font: 'inherit',
      },
    }

    /**
     * Render the progress dialog.
     * @returns {object|null} the overlay element.
     */
    function ProgressDialog() {
      const state = useDialogState()
      if (!state || !state.open) return null
      const done = state.state === 'done'
      const failed = state.state === 'error'
      return h('div', { style: styles.backdrop, role: 'dialog', 'aria-modal': 'true' },
        h('style', null, ANIMATION),
        h('div', { style: styles.card },
          h('div', { style: styles.title }, done ? '导出完成' : failed ? '导出失败' : '正在导出'),
          h('div', { style: styles.track },
            done
              ? h('div', { style: styles.full })
              : failed
                ? h('div', { style: { ...styles.full, background: '#d9534f' } })
                : h('div', { style: { ...styles.fill, animation: 'handoff-bar 1.2s linear infinite' } })),
          failed
            ? h('div', { style: styles.error }, state.message)
            : done
              ? h('div', { style: styles.detail }, state.message)
              : h('div', { style: styles.detail }, `${state.phase || '正在打包…'}　已用 ${state.elapsed || 0} 秒`),
          done || failed
            ? h('div', { style: styles.actions },
              h('button', { style: styles.button, onClick: () => publish(null) }, '关闭'))
            : null,
        ))
    }

    /**
     * Open the Host directory picker.
     *
     * `pick()` answers a RemoteResult, not a bare path: `{ok:true, value:string|null}`
     * on success (null = the operator cancelled) and `{ok:false, error}` on
     * failure. Treating a non-string result as a cancel silently swallowed the
     * gesture, so the shape is logged and classified explicitly.
     *
     * @param {object} ctx - browser plugin context.
     * @returns {Promise<string>} chosen absolute path.
     */
    async function pickFolder(ctx) {
      const picker = ctx.remote && ctx.remote.directoryPicker
      if (!picker || typeof picker.pick !== 'function') {
        throw new Error('当前界面没有可用的文件夹选择器（directoryPicker 未挂载）')
      }
      const result = await picker.pick()
      console.log('[handoff] picker result:',
        result === null || result === undefined ? String(result) : `ok=${result.ok} value=${JSON.stringify(result.value)}`)
      if (result === null || result === undefined) {
        throw new Error('文件夹选择器没有返回结果')
      }
      if (result.ok !== true) {
        const detail = result.error && result.error.message ? result.error.message : '未知错误'
        throw new Error(`文件夹选择器失败：${detail}`)
      }
      const value = result.value
      if (value === null || value === undefined) {
        throw new Error('__cancelled__')
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`文件夹选择器返回了无法识别的值：${JSON.stringify(value)}`)
      }
      return value.trim()
    }

    /**
     * Notify through the shared toast, or the console.
     * @param {object} ctx - browser plugin context.
     * @param {string} text - message.
     * @param {boolean} ok - success flag.
     */
    function notify(ctx, text, ok) {
      console.log('[handoff]', ok ? 'ok' : 'fail', text)
      try {
        if (ctx.contextMenus && typeof ctx.contextMenus.notify === 'function') {
          ctx.contextMenus.notify(text, ok)
          return
        }
      } catch (error) {
        console.error('[handoff] toast failed', error)
      }
    }

    /**
     * Run one `/handoff …` command through the Host command channel.
     * @param {object} ctx - browser plugin context.
     * @param {string} sessionId - session the command runs against.
     * @param {string} line - full command line, leading slash included.
     * @returns {Promise<string>} result text.
     */
    async function viaCommand(ctx, sessionId, line) {
      const commands = ctx.remote && ctx.remote.commands
      if (!commands || typeof commands.execute !== 'function') {
        throw new Error('remote.commands 未挂载')
      }
      console.log('[handoff] executing', line)
      const result = await commands.execute(sessionId, line, [])
      if (!result || result.ok !== true) {
        const detail = result && result.error ? `${result.error.code}: ${result.error.message}` : '命令执行失败'
        throw new Error(detail)
      }
      const value = result.value
      if (value && value.kind === 'error') throw new Error(value.text || '命令执行失败')
      return (value && value.text) || '完成'
    }

    /**
     * Export through the Host HTTP route.
     * @param {string} target - chosen folder.
     * @param {string} sessionId - optional Session to pack alone.
     * @returns {Promise<string>} result text.
     */
    async function viaHttp(target, sessionId) {
      const params = new URLSearchParams({ target })
      if (sessionId) params.set('session', sessionId)
      console.log('[handoff] fetching', `${EXPORT_ROUTE}?${params.toString()}`)
      const response = await fetch(`${EXPORT_ROUTE}?${params.toString()}`, { method: 'GET' })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return `已导出到\n${payload.dir}`
    }

    /**
     * Pick a folder, reporting a real failure but staying quiet on cancel.
     * @param {object} ctx - browser plugin context.
     * @returns {Promise<string|null>} the chosen folder, or null.
     */
    async function chooseFolder(ctx) {
      try {
        return await pickFolder(ctx)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (message !== '__cancelled__') notify(ctx, `无法选择文件夹：${message}`, false)
        return null
      }
    }

    /**
     * Show the progress dialog while one operation runs, then its outcome.
     * @param {object} ctx - browser plugin context.
     * @param {string} phase - label shown while running.
     * @param {string} startToast - toast shown at the start.
     * @param {() => Promise<string>} work - the operation.
     * @param {string} doneToast - toast shown on success.
     * @param {string} failPrefix - toast prefix on failure.
     * @returns {Promise<void>} settles after the dialog reaches a final state.
     */
    async function runWithProgress(ctx, phase, startToast, work, doneToast, failPrefix) {
      const startedAt = Date.now()
      publish({ open: true, state: 'running', phase, elapsed: 0, message: '' })
      notify(ctx, startToast, true)
      const timer = setInterval(() => {
        if (store.value && store.value.state === 'running') {
          publish({ ...store.value, elapsed: Math.round((Date.now() - startedAt) / 1000) })
        }
      }, 500)
      try {
        const text = await work()
        publish({ open: true, state: 'done', phase: '完成', elapsed: 0, message: text })
        notify(ctx, doneToast, true)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        console.error('[handoff] failed:', message)
        publish({ open: true, state: 'error', phase: '失败', elapsed: 0, message })
        notify(ctx, `${failPrefix}：${message}`, false)
      } finally {
        clearInterval(timer)
      }
    }

    /**
     * Pick a destination, then export this Session or every Session.
     * @param {object} ctx - browser plugin context.
     * @param {string} sessionId - Session to pack alone, or '' for every Session.
     * @returns {Promise<void>} settles after the dialog reaches a final state.
     */
    async function exportFlow(ctx, sessionId) {
      const target = await chooseFolder(ctx)
      if (!target) return
      console.log('[handoff] folder chosen:', target)
      const line = sessionId
        ? `/handoff export-session ${sessionId} ${target}`
        : `/handoff export ${target}`
      await runWithProgress(ctx, '正在打包会话数据…', '开始导出，请稍候…', async () => {
        try {
          return await viaCommand(ctx, sessionId, line)
        } catch (commandError) {
          console.error('[handoff] command path failed, trying HTTP:', commandError)
          return await viaHttp(target, sessionId)
        }
      }, '导出完成', '导出失败')
    }

    /**
     * Pick a bundle folder, then import it into this machine.
     * @param {object} ctx - browser plugin context.
     * @param {string} sessionId - Session the command runs against.
     * @returns {Promise<void>} settles after the dialog reaches a final state.
     */
    async function importFlow(ctx, sessionId) {
      if (!sessionId) {
        notify(ctx, '请先打开一个会话，再从工作区菜单导入', false)
        return
      }
      const target = await chooseFolder(ctx)
      if (!target) return
      console.log('[handoff] bundle folder chosen:', target)
      await runWithProgress(ctx, '正在还原会话数据…', '开始导入，请稍候…',
        () => viaCommand(ctx, sessionId, `/handoff import ${target}`),
        '导入完成，重启 DSH 后生效', '导入失败')
    }

    /**
     * Build a 16px stroke glyph from path data. `currentColor` keeps the icon in
     * step with the menu row's own text color in either theme.
     * @param {string[]} paths - SVG path data.
     * @returns {Function} a React component.
     */
    function glyph(paths) {
      return function Icon() {
        return h('svg', {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, paths.map((d, index) => h('path', { key: index, d })))
      }
    }

    /** Arrow leaving a tray — one Session goes out. */
    const IconExportOne = glyph(['M8 9.5V2.5', 'M5.5 5 8 2.5 10.5 5', 'M3 11v2.5h10V11'])
    /** The same arrow plus a stack hint — every Session. */
    const IconExportAll = glyph(['M8 9.5V2.5', 'M5.5 5 8 2.5 10.5 5', 'M3 11v2.5h10V11', 'M1.5 3.5h3', 'M1.5 6.5h3'])
    /** Arrow dropping into a tray — a bundle comes in. */
    const IconImport = glyph(['M8 2.5v7', 'M5.5 7 8 9.5 10.5 7', 'M3 11v2.5h10V11'])

    return {
      inject: ['contextMenus', 'remote', 'remote.directoryPicker', 'remote.commands', 'slots'],
      /**
       * Register the progress overlay, the menu icons and the menu actions.
       * @param {object} ctx - browser plugin context.
       */
      apply(ctx) {
        console.log('[handoff] client', VERSION, 'loaded')
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'handoff-progress',
          }, ProgressDialog))
          console.log('[handoff] progress overlay registered')
        } catch (error) {
          console.error('[handoff] 进度窗口注册失败', error)
        }

        try {
          ctx.slots.inject('contextMenu.icon', function* icons() {
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'handoff.icon.export-one' }, IconExportOne)
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'handoff.icon.export-all' }, IconExportAll)
            yield ctx.slots.register({ name: 'contextMenu.icon', key: 'handoff.icon.import' }, IconImport)
          })
          console.log('[handoff] menu icons registered')
        } catch (error) {
          console.error('[handoff] 菜单图标注册失败', error)
        }

        /**
         * Menu entries for one captured Session: export only. Import lives on
         * the Workspace menu, where the operator manages whole workspaces.
         * @param {string} sessionId - captured Session id, or ''.
         * @returns {Array<object>} menu actions.
         */
        const actionsFor = (sessionId) => {
          const all = {
            id: 'all-folder',
            label: '导出全部会话到文件夹…',
            icon: { key: 'handoff.icon.export-all' },
            run: () => exportFlow(ctx, ''),
          }
          if (!sessionId) return [all]
          // Same group: no divider between the two export rows.
          return [
            { id: 'session-folder', label: '导出此会话到文件夹…', icon: { key: 'handoff.icon.export-one' }, run: () => exportFlow(ctx, sessionId) },
            all,
          ]
        }

        /**
         * Resolve the Session the composer is showing, which is the Session the
         * import command runs against when the menu target is a Workspace.
         * @returns {string} a Session id, or '' when none is open.
         */
        const currentSessionId = () => {
          try {
            const ui = typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined
            const value = ui && ui.current ? ui.current.value : undefined
            const key = value && value.key
            return typeof key === 'string' ? key : ''
          } catch (error) {
            console.error('[handoff] cannot read the current Session', error)
            return ''
          }
        }

        const mount = (id, target, build, order = 500) => {
          try {
            const register = () => ctx.contextMenus.register({
              id,
              target,
              order,
              resolve: (captured) => build(captured),
            })
            if (typeof ctx.effect === 'function') ctx.effect(register, `handoff: ${target} menu`)
            else register()
            console.log('[handoff] menu registered for', target, 'order', order)
          } catch (error) {
            console.error(`[handoff] ${target} 菜单注册失败`, error)
          }
        }

        mount('handoff.export', 'session', (captured) =>
          actionsFor(captured && captured.sessionId ? captured.sessionId : ''))
        mount('handoff.export.header', 'sessionHeader', (captured) =>
          actionsFor(captured && captured.sessionId ? captured.sessionId : ''))
        // 250 sits after "在文件夹显示" (200) and before "删除工作区" (300), so the
        // entry belongs to the rename group instead of trailing the menu.
        mount('handoff.import', 'workspace', () => [{
          id: 'import-bundle',
          label: '导入会话数据包…',
          icon: { key: 'handoff.icon.import' },
          run: () => importFlow(ctx, currentSessionId()),
        }], 250)
      },
    }
  },
})
