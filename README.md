# Larkin

Larkin connects Codex, Claude Code, and Pi agent runtimes to Feishu. It provides a local runtime host, persistent sessions, reminders, interactive messages, and a local dashboard.

## Downstream distribution maintenance / 下游发行版维护

`dalianzhu/larkin` 是基于 [`eddiearc/larkin`](https://github.com/eddiearc/larkin) 维护的下游发行版，两者采用类似 Linux core 与发行版的协作关系。

### 上游与下游边界

- `eddiearc/larkin` 是上游核心，负责纯粹、通用的飞书能力，包括飞书 API 适配、Runtime Host 核心架构、消息安全边界和通用交互能力。
- `dalianzhu/larkin` 是可构建、安装和实际运行的下游发行版。在上游核心之上维护本地业务所需的通用扩展，例如经认证的 external agent enqueue。
- 上游坚持“所有 Agent 数据源来自飞书”；下游允许受认证的本地自动化向 Agent 投递通用消息。这是双方已确认的产品边界，不以合入上游为目标。
- 业务语义应尽量留在调用方。例如 Quality Gate 负责在消息正文中提供 flow、任务和目标信息；Larkin 的 enqueue 只负责可靠投递任意消息，不理解 Quality Gate 或特定飞书路由。
- `origin/main` 代表下游可发布版本，可以有意领先并偏离上游；`upstream/main` 始终代表官方核心，不在本仓库另建“纯净 main”副本。

本地 remote 约定：

```text
origin    git@github.com:dalianzhu/larkin.git
upstream  git@github.com:eddiearc/larkin.git
```

首次配置：

```bash
git remote add upstream git@github.com:eddiearc/larkin.git
git fetch --no-tags upstream main
```

### 分支与开发流程

下游需求从最新的 `origin/main` 切功能分支，完成测试后合回下游 `main`：

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/<feature-name>
# 开发、测试、提交、推送
git switch main
git merge --no-ff codex/<feature-name>
git push origin main
```

适合贡献给官方的纯核心改动必须直接从 `upstream/main` 切分支，避免把下游功能夹带进上游 PR：

```bash
git fetch --no-tags upstream main
git switch -c upstream-fix/<change-name> upstream/main
```

### 同步上游

已发布的下游 `main` 不做 rebase 或 force-push。同步官方时使用 merge，保留下游版本的完整来源：

```bash
git fetch --no-tags upstream main
git switch main
git pull --ff-only origin main
git merge --no-ff upstream/main
bun install --frozen-lockfile
bun test
git push origin main
```

同步时必须审查冲突是否跨越以下边界：本地控制面、Inbox、freshness、飞书身份锁定、Runtime 唤醒和 release tooling。不能为了快速同步而绕过这些安全约束。

不要把上游 tags 镜像到 `origin`，也不要使用 `git push --tags`。上下游 release tooling 都使用 `vX.Y.Z` 标签，混合标签会造成同名 tag 指向不同提交。同步上游只获取 branch，使用 `--no-tags`。

### 版本号管理

- 下游继续使用仓库现有的稳定 SemVer `MAJOR.MINOR.PATCH`，不使用当前 release tooling 不支持的预发布后缀。
- 每个可发布的下游功能或修复都必须递增版本；默认递增 `PATCH`，不复用任何已经发布的下游版本号。
- 同步上游后，比较 `upstream/main` 的 `package.json` 版本与最近一个下游发布版本，取较大者作为基线，再至少递增一次 `PATCH`。例如上游为 `0.2.58`、下游已发布 `0.2.59`，下一个下游版本应为 `0.2.60`。
- `MINOR` 和 `MAJOR` 仅用于确有对应兼容性语义的变更，不用来标识“来自下游”。发行版身份由仓库地址、release manifest 的 `sourceCommit` 和构建来源共同确认。
- release commit 必须保持工作树干净、已推送，并通过 typecheck、build、测试、license 和 publication checks；安装工件必须显示 `sourceDirty: false`。
- 发现上下游使用了相同版本号时，不覆盖、不移动已有 tag；下游直接递增到新的未使用版本，并从明确的上游 commit 重新构建。

当前发行关系：上游基线为 `eddiearc/larkin@e14fc5c`（`0.2.57`），下游 external enqueue 发行版为 `0.2.59`。后续同步时以实际的 `upstream/main` 和下游最新 release 为准，不把本段中的 commit 当作永久固定基线。

## Requirements

- A supported macOS or Linux system
- `lark-cli`
- At least one supported agent runtime and its authentication
- Bun 1.3.14 when building from source

## Usage

```bash
larkin setup
larkin start
larkin status
```

Run `larkin --help` or `larkin config --help` for the available commands and configuration options. Local configuration is stored under `~/.larkin` by default; set `LARKIN_CONFIG_DIR` to use another directory.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
```

Use `bun run publication:check:tree` to verify the repository publication boundary and `bun run licenses:check` to verify the runtime-only third-party notice generator.

## License and security

Larkin is licensed under the [Apache License 2.0](./LICENSE). Runtime dependency notices are generated and included with every release. See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.
