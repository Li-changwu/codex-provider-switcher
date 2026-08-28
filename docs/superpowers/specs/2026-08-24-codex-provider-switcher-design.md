# Codex Provider Switcher Design

状态：设计已确认，待文档审阅
目标版本：第一版支持 Windows 和原生 Linux；暂不支持 macOS、WSL 和云端同步

## 1. 目标

开发一个 VS Code 扩展，在 VS Code Remote SSH 场景下管理当前远端主机上的 Codex 配置和历史会话。

扩展提供：

- 官方账号与多个自定义中转站 Profile 之间的切换。
- 使用用户提供的 `auth.json` API Key 和 `config.toml` 配置。
- 切换时同步 Codex 本地会话的 Provider 元数据，使原生 Codex 的 `/resume` 能重新发现历史。
- 原会话无法跨 provider 继续时，使用原生 `codex fork` 创建可继续的新会话。
- 会话同步进度显示、取消、备份和完整回滚。
- 限制分叉会话、临时文件和备份的增长。

## 2. 非目标

- 不开发独立聊天窗口，不替代原生 Codex CLI 或 Codex Desktop。
- 不把官方 OAuth 凭据保存到扩展的 Profile 中，也不代替官方 `codex login` 流程。
- 不把聊天数据同步到 Windows 本机、其他服务器或云端。
- 不承诺跨 provider/account 解密并继续所有历史内容。
- 第一版不支持 macOS、WSL 和常驻后台服务。

## 3. 运行边界

扩展在当前 VS Code Extension Host 所在的机器上执行文件操作。

- 普通 Windows 工作区：管理 Windows 用户的 Codex Home。
- 普通 Linux 工作区：管理 Linux 用户的 Codex Home。
- VS Code Remote SSH：管理 SSH 远端 Linux 用户的 Codex Home。
- WSL 工作区：第一版明确拒绝直接操作，并提示使用 WSL 内的 VS Code/扩展环境。

扩展不通过本机 Windows 侧的路径访问远端 Linux 的 SQLite，也不使用 UNC 路径写入数据库。

## 4. 组件

### 4.1 HostLocator

根据 VS Code Extension Host 的运行环境解析 Codex Home，并确认操作系统、路径布局和 SQLite 位置。路径解析遵循 Codex 自身配置和环境变量；无法确认布局时停止操作，不猜测路径。

### 4.2 ProfileManager

负责 Profile 的创建、校验、读取、更新和删除。

Profile 分为两类：

- `official`：只保存官方模式下的配置基线，不保存 OAuth 登录内容。切换后由用户执行原有 `codex login`。
- `custom`：保存名称、完整的 `config.toml` 模板、Provider 标识、Base URL、模型设置和 API Key 引用。

用户通过 VS Code 界面创建 Profile；配置文件使用 TOML 解析器校验，保留用户未被扩展管理的合法字段。API Key 使用远端 Extension Host 的 SecretStorage 保存，不能进入普通 Profile 文件、日志或备份。

非敏感 Profile 文件存放在当前 Codex Home 下的
`provider-switcher/profiles/<profile-id>/config.toml`；扩展状态库和事务日志也只存放在当前 Codex Home 下。若远端 Extension Host 不提供可确认位于远端的 SecretStorage，扩展拒绝保存 API Key，而不是回退到普通明文 Profile 文件。

切换到自定义 Profile 时，扩展只在当前 Codex Home 生成所需的活动 `auth.json`，文件权限设为仅当前用户可读写。切换到官方 Profile 时清理中转站认证文件，并执行官方登录流程。

### 4.3 CodexStorageAdapter

封装会话文件、归档会话和 SQLite 索引的读写。适配器只修改 Provider 相关元数据，不修改消息正文、会话标题或时间戳。它必须识别不支持的 Codex 数据库布局并安全失败。

SQLite 访问使用 `sqlite3` `^6.0.1` 的 N-API 绑定，而不是依赖特定 Visual Studio 工具链版本的 `@vscode/sqlite3`。该版本要求 Node 20.17 及以上，因此扩展最低支持 VS Code `^1.98.0`。发布包仍按 Windows x64 和 Linux x64 分别生成；每个 VSIX 必须包含其目标平台可加载的 `sqlite3` 原生模块。验证器必须解压 VSIX，并在最小化且不含 Node 加载器变量的子 Node 进程中实际执行 `require("sqlite3")`，而不是只检查目录或假定绑定文件路径。VSIX 仅包含 SQLite 的运行时加载器、必要依赖和原生模块，不能包含 `node-gyp`、`prebuild-install`、`tar` 或源代码归档。预构建绑定不可用、加载超时、加载失败或 `npm audit --omit=dev` 检出漏洞时，打包失败，不能发布缺少数据库能力或带有已知生产依赖漏洞的扩展。

### 4.4 SwitchTransaction

把 Profile 切换和会话同步作为一个事务管理。它负责锁、备份、暂存、提交、验证、回滚和恢复日志。

### 4.5 ContinuationService

优先调用当前远端安装的原生 Codex CLI：

```text
codex resume <session-id>
codex fork <session-id>
```

其中 `codex fork` 用于保留原会话并创建新分支。若当前 CLI 不支持或因跨 provider 加密内容失败，扩展才使用可读取的文本内容生成一次性上下文，并启动新的原生 Codex 会话。此路径明确标记为“基于可读取内容续写”，不能伪装成完整历史恢复。

### 4.6 RecoveryManager

维护事务日志、备份清单、临时文件清理和启动恢复。扩展崩溃或服务器断连后，下一次操作前先恢复未完成事务。

## 5. Profile 切换流程

1. 用户从状态栏或命令面板选择目标 Profile。
2. 扩展确认当前没有进行中的切换，并检查 Codex/SQLite 是否可安全操作。
3. 创建配置、会话文件和 SQLite 的受控备份；备份中排除 API Key 和 OAuth 内容。
4. 解析并校验目标 Profile 的 TOML 和 SecretStorage 中的 API Key。
5. 在临时位置准备目标配置和会话元数据变更。
6. 更新会话文件和 SQLite Provider 元数据。
7. 验证文件哈希、SQLite 记录数量和目标 Provider 值。
8. 写入暂存的目标 `config.toml` 和活动认证状态。
9. 目标为官方 Profile 时，在远端终端执行原有 `codex login`，扩展不接管登录交互；只有登录命令成功并检测到有效认证状态后，事务才允许最终提交。
10. 目标为自定义 Profile 时验证活动 `auth.json` 的格式和权限，然后最终提交。
11. 清理临时文件并更新 Profile/会话映射。

任意步骤失败都保持原活动 Profile 不变，并从备份恢复已修改的数据。由于文件和 SQLite 不能依靠单一原子操作同时提交，事务日志和启动恢复是必须的。

## 6. 进度与取消

使用 VS Code 原生可取消进度通知。进度阶段包括：预检查、备份、扫描会话、写入会话、写入 SQLite、验证和提交。

扫描完成后显示 `已处理数量/总数量`；扫描期间总量未知时显示不确定进度。取消请求不会留下部分同步结果，而是停止后回滚完整事务。提交阶段不再接受新的 Profile 切换；必要时等待当前提交完成后再恢复。

## 7. 会话同步和分叉版本

Codex 原生会话文件仍是唯一正文来源。扩展自己的状态库只保存：

- 原会话 ID。
- 目标 Profile ID。
- 已创建的分叉会话 ID。
- 最近同步的事件位置或哈希。
- 分叉状态和时间。

同一源会话切换到同一目标 Profile 时，优先复用已有分叉，不重复复制。只有源会话出现新内容时才允许创建新的分叉。

超过用户设置的分叉数量后，旧分支优先归档，不自动永久删除。默认每个“源会话 + 目标 Profile”保留 3 个分叉，默认保留最近 10 份事务备份；两项都提供配置项修改。永久删除必须由用户显式确认。

临时上下文文件在续写启动成功后立即删除；异常残留文件使用启动清理和过期时间清理。会话扫描采用流式读取，不能把全部历史加载到内存。

## 8. 错误和安全处理

- Codex 正在运行或 SQLite 被占用：不强行写入，提示用户关闭 Codex 后重试。
- TOML/JSON 无效或缺少必需字段：在写入前报告具体字段错误。
- API Key 缺失：不生成活动 `auth.json`，Profile 不可切换。
- 目标 Provider 无法访问：回滚本地切换，不报告同步成功。
- `resume`/`fork` 因加密内容失败：保留原会话，提供基于可读取文本的续写选项。
- 扩展或服务器中断：根据事务日志和备份恢复，不允许启动后继续使用半提交状态。
- 日志和进度消息必须脱敏，不记录 API Key、OAuth 内容或完整聊天正文。
- 任何把历史交给新 provider 的续写动作都必须先向用户确认。

## 9. VS Code 界面

第一版使用 VS Code 原生 API：

- 状态栏显示当前 Profile。
- 命令面板提供新建、编辑、切换、同步、续写和恢复备份。
- Profile 编辑使用输入框、密码输入和 TOML 文本编辑器。
- 切换和同步使用 `withProgress` 显示阶段、数量和取消按钮。
- 错误使用可展开的 VS Code 通知，并提供查看脱敏日志的入口。

不开发独立 Web UI 或扩展内聊天面板。

## 10. 测试和验收

### 单元测试

- Profile schema、JSON/TOML 校验和敏感字段脱敏。
- Windows/Linux Codex Home 路径解析。
- Provider 元数据变更和未知 schema 拒绝。
- 进度计算、事务状态机和映射去重。
- 临时文件清理、备份保留和恢复决策。

### 集成测试

使用临时 Codex Home 和固定会话/SQLite fixture，覆盖：

- 官方到自定义 Profile，以及自定义 Profile 之间切换。
- 同步中取消、写入阶段异常、验证失败和进程崩溃恢复。
- SQLite 锁定、Codex 正在运行和数据库 schema 不兼容。
- `codex resume`/`codex fork` 成功、不可用和加密内容失败。
- 大量会话下的流式扫描和内存上限。

### 验收标准

成功切换时，目标 Profile 生效，历史在原生 Codex 中重新可见；续写失败时原会话仍保持可用。失败或取消时，配置、会话文件和 SQLite 恢复到同步前状态。重复续写不会无条件生成重复分支。官方登录始终使用原有 `codex login` 流程。

## 11. 已知限制

Provider 元数据同步只能恢复本地历史的可见性。跨 provider 或 account 继续旧会话时，Codex 后端可能无法解密历史中的 `encrypted_content`；这时只能使用原生分叉失败后的可读取内容续写，不能保证完整上下文等价。

Codex 本地文件和 SQLite schema 可能随 CLI 版本变化。适配器必须带 schema 检测和备份保护，不能在未知布局上继续写入。
