# 离线交接包（dsh-handoff）

把「全部会话 + 它们各自的工作区 + 全部附件 + 插件自身」打包成**一个普通文件夹**，拷到另一台电脑后一条命令还原。**不经过网络，不依赖任何第三方包。**

## 装一次

- 本机：**插件 → 添加插件 → 选择本目录**（本目录就是包含 `package.json` 的那一层）。
- 另一台电脑：交接包里自带 `plugin/` 子目录，同样用「添加插件」选中它即可。

装完输入 `/handoff` 查看用法，或在左侧会话上**点右键**。

## 右键导出 / 导入（v0.9.1）

菜单分工：**导出在会话上，导入在工作区上**。

**会话右键**：

| 菜单项 | 作用 |
|---|---|
| **导出此会话到文件夹…** | 只导这个会话 + 它自己的工作区 + **它引用到的附件** |
| **导出全部会话到文件夹…** | 全部会话 + 全部工作区 + 全部附件 |

**工作区右键**（左侧"工作区"那一行，和 重命名 / 在文件夹显示 / 删除工作区 同级）：

| 菜单项 | 作用 |
|---|---|
| **导入会话数据包…** | 选一个交接包文件夹（或装着它的上级文件夹），还原会话、工作区、附件 |

导入会在**当前打开的那个会话**里执行（命令需要绑定一个会话）。没有打开任何会话时会提示「请先打开一个会话，再从工作区菜单导入」。

**导入说明**：选中含 `manifest.json` 的 `handoff-…` 目录即可；如果选的是装着多个包的上级目录，会自动取其中**最新**的一个。包可以放在任意位置（U 盘、网盘挂载、桌面），不要求在导出目录里。导入完成后会提示「重启 DSH 后生效」。

导入时会自动把会话日志里的 `cwd` 改写成目标工作区路径，避免出现服务起不来的问题。

选完目录后的流程：

1. 进度窗口：不确定态进度条 + 「已用 N 秒」
2. 先走命令通道（`/handoff export…` / `/handoff import …`），导出还存在 HTTP 兜底
3. 完成显示「导出完成 / 导入完成」，失败显示具体原因

### 排查用日志

控制台过滤 `handoff`：

```
[handoff] client 0.9.1 loaded
[handoff] progress overlay registered
[handoff] menu registered for session
[handoff] menu registered for workspace
[handoff] picker result: ok=true value="D:\..."
[handoff] executing /handoff import D:\...
[handoff] ok 导入完成，重启 DSH 后生效
```

### 关于进度条

进度条是**不确定态**（来回滑动）而不是百分比：命令只会在结束时返回结果，中途没有进度回传。「已用 N 秒」是真实计时。

没有"默认目录"选项：目标目录必须在弹框里选。

Host 侧诊断路由（可选，不影响上面的流程）：

| 路由 | 作用 |
|---|---|
| `GET /api/handoff.ping` | 探活，返回插件版本与默认导出目录 |
| `GET /api/handoff.export?target=&session=&job=1` | 后台任务，返回 `jobId`；不带 `job` 时同步执行 |
| `GET /api/handoff.progress?job=<id>` | 返回 `{state, phase, done, total, result|error}` |

安全限制：目标必须是**绝对路径**，且不能落在 Harness 数据目录（`.dsh`、`sessions`、`attachments`）内部；带引号或 `file://` 的路径会自动归一化。

## 用法

| 命令 | 作用 |
|---|---|
| `/handoff export` | 打包全部到 `%USERPROFILE%\dsh-handoff\handoff-YYYYMMDD-HHmmss\` |
| `/handoff export D:\某个文件夹` | 打包全部到指定目录（绝对路径） |
| `/handoff export-session <会话id> [目录]` | 只打包指定会话及其附件 |
| `/handoff import` | 还原导出目录里**最新**的包 |
| `/handoff import handoff-20261114-120500` | 还原指定的包 |
| `/handoff list` | 列出本机导出目录里的包 |
| `/handoff status` | 显示路径、包数量、导入映射 |

包内容：

```
handoff-20261114-120500/
  manifest.json      清单（会话 id、cwd、工作区、附件统计）
  sessions/          会话日志，按后端原始目录结构存放
  workspace/01-xxx/  每个会话所属工作区的一份拷贝
  attachments/       附件库（图片、文件）
  plugin/            本插件，方便在另一台机器上安装
  README.txt         包里附带的说明
```

## 换机器的最短路径

1. 源机器：`/handoff export`
2. 把整个 `handoff-…` 文件夹拷到 U 盘 / 移动硬盘
3. 目标机器：装上包里 `plugin/`，启动一次 DSH
4. 目标机器：`/handoff import`
5. **重启 DSH**，会话出现在列表里

> 导入时最好让 DSH 处于空闲状态；会话日志是追加写的，正在写的时候复制可能截到半行，读取端会自行丢弃。

## 可选配置

改 `cordis.patch.yml` 里 `config`，重启 DSH 生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `exportRoot` | `%USERPROFILE%\dsh-handoff` | 包的读写目录，建议放在同步盘或移动硬盘上 |
| `targetWorkspace` | 空 | **路径不同时必填**。导入时把所有工作区还原到这个目录 |
| `workspaces` | `[]` | 除会话自身工作区外，额外要打包的目录 |
| `overwrite` | `false` | 导入时是否覆盖已存在的文件 |
| `includeAttachments` | `true` | 是否打包附件库 |
| `maxWorkspaceBytes` | `2 GB` | 单个工作区的大小上限，超了跳过 |
| `exclude` | 见下 | 追加排除的目录名 |

默认排除：`node_modules .git obj bin .vs dist build target __pycache__ .venv venv .next .nuxt .idea .gradle`

### 路径不一致时（最常见的坑）

DSH 的会话目录按工作区路径命名，而且**会话日志头里还记着自己的 `cwd`**。这两处只要和本机实际路径对不上，就可能让工作区/会话服务在启动时挂掉（表现为 `service unavailable`）。

这个插件在导入时会**重写日志头里的 `cwd`**，保证：

1. 会话文件落在 `projectKey(目标工作区)` 这个目录下；
2. 日志头里的 `cwd` 等于目标工作区路径；
3. 重写后逐帧校验，最后再落盘（校验失败就跳过这个会话，绝不写坏文件）。

所以目标机器路径不同时，你有三种选择：

1. **什么都不设**：源路径不存在时自动落到 `%USERPROFILE%\.dsh\dsh-workspaces\<目录名>`，会话的 `cwd` 同步改成那里；
2. **设 `targetWorkspace`**：所有工作区统一还原到指定目录；
3. **两台机器用同一个路径**（如 `C:\dsh-ws`）：`cwd` 本来就不用改。

> 旧版本（0.1.x）导入时不改 `cwd`，会导致下一次启动 Host 服务起不来。如果你已经踩过这个坑：删掉 `%USERPROFILE%\.dsh\sessions\` 下由导入产生的目录，或直接把整个 `.dsh` 改名重建，然后用本版本重新导入。

## 边界（提前知道）

- **不做实时同步**：这是"交接"，不是"两台同时聊一个会话"。同一会话只能一台机器在写。
- **不合并冲突**：`overwrite: false` 时导入只补齐缺失文件，绝不删除、绝不覆盖；对已存在且 `cwd` 过期的会话文件会做一次就地修复。
- **工作区里的 `.git` 默认不打包**：代码历史请用 `git push`，包只负责工作副本。
- 打包在主进程同步执行，超大工作区会让界面卡一下；用 `maxWorkspaceBytes` 兜底。
- 会话的 `cwd` 由导入自动重写为本机路径，不需要再手动告诉 agent。

## 实现

- `index.js`：注册 `/handoff` 命令，渲染结果
- `lib/core.js`：扫描会话、读日志头、复制树、生成/还原清单（纯 Node，零依赖）
- 会话目录名编码完全复刻 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey`，保证与后端一致
