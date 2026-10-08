## Purpose

为 fork 仓库 `main` 分支上人工准备的 `@deepctrls/craftjs` 版本定义安全的发布流程，覆盖 npm 发布、GitHub 发布记录，以及部分失败后的恢复行为。

## ADDED Requirements

### Requirement: 发布流程仅作用于指定仓库和 main 分支
工作流 MUST 仅在 `hnldlsjzt/craft.js` 的 `main` 分支上 `scripts/logic-package.json` 发生变更时由 push 事件执行发布。手动触发的 workflow MUST 同样限制在该仓库和 `main` 分支。仅修改其他文件 MUST NOT 触发 push 发布。

#### Scenario: 目标 main 分支上的版本元数据发生变化
- **WHEN** 修改 `scripts/logic-package.json` 的提交被推送到 `hnldlsjzt/craft.js:main`
- **THEN** 工作流针对该提交启动

#### Scenario: 仅修改工作流文件
- **WHEN** `main` 上的提交只修改 `.github/workflows/release.yml`
- **THEN** push 事件不会启动发布工作流

#### Scenario: 运行目标仓库或分支不符合要求
- **WHEN** push 或手动触发的目标不是 `hnldlsjzt/craft.js` 的 `main` 分支
- **THEN** 不执行任何发布或发包操作

### Requirement: npm 发布必须使用通过验证的包产物
工作流 MUST 在发布前完成版本预检、测试、构建、lint、打包，以及 React 18 和 React 19 消费者验证。若 npm 尚无该版本，工作流 MUST 发布通过消费者验证的同一个 tarball，并使用 npm Trusted Publishing。只有 npm 发布 job MUST 获得 `id-token: write` 权限。

#### Scenario: 新版本通过所有验证
- **WHEN** npm 中不存在该包版本且所有验证步骤均成功
- **THEN** 工作流通过 npm Trusted Publishing 发布已验证的 tarball

#### Scenario: 验证失败
- **WHEN** 任一必需验证步骤失败
- **THEN** 工作流不发布 npm 包，也不创建 GitHub 发布记录

#### Scenario: npm 中已存在该版本
- **WHEN** 版本预检确认 npm 中已存在该包版本
- **THEN** 工作流完成验证，但跳过 npm 发布、Git tag 创建和 GitHub Release 创建

#### Scenario: 发布人手动验证 Trusted Publisher
- **WHEN** 发布人在目标仓库 `main` 手动选择 stage-only 模式并提供 npm 中尚不存在的稳定版本，且所有验证成功
- **THEN** 工作流通过 OIDC 将同一个已验证 tarball 提交到 npm staged publishing，不正式发布该版本，也不创建 Git tag 或 GitHub Release

#### Scenario: stage-only 输入版本冲突或验证失败
- **WHEN** stage-only 模式的版本已发布、已被另一个 staged package 占用，或任一必需验证失败
- **THEN** 工作流失败且不提交 staged package、不执行正式发布，也不创建 GitHub 发布记录

### Requirement: Git tag 和 GitHub Release 必须指向实际发布的源码提交
npm 发布 job 成功后，工作流 MUST 确保 `v<version>` tag 指向触发工作流的提交，并为该 tag 创建带有 GitHub 自动生成说明的 Release。重复执行 MUST 保留匹配的现有记录，并且 MUST NOT 覆盖指向其他目标的 tag 或 Release。

#### Scenario: npm 发布成功且记录尚不存在
- **WHEN** 新版本的 npm 发布 job 成功，且对应 tag 和 Release 均不存在
- **THEN** 工作流在触发提交上创建 `v<version>`，并创建带自动生成说明的 GitHub Release

#### Scenario: 匹配的 tag 或 Release 已存在
- **WHEN** npm 发布 job 成功，且已存在的 tag 或 Release 与版本和触发提交匹配
- **THEN** 工作流将其视为已完成，只创建缺失且匹配的记录

#### Scenario: 已有 tag 指向其他提交
- **WHEN** `v<version>` 已存在，但没有指向触发提交
- **THEN** 工作流失败，不移动或替换该 tag，也不创建不匹配的 Release

#### Scenario: 已有 Release 与 tag 冲突
- **WHEN** `v<version>` 的 Release 已存在，但其关联 tag 或目标提交与触发提交不匹配
- **THEN** 工作流失败，不覆盖该 Release

### Requirement: 发布后恢复必须绑定到原始工作流运行
只有同一 workflow run 中的 npm 发布 job 成功时，Git tag 和 GitHub Release 阶段才 MUST 允许单独重跑。恢复流程 MUST 使用该 run 的版本和触发提交，确认该版本可从 npm 查询到，并且 MUST NOT 根据 npm 中已有版本或后续提交推断发布来源。若无法确认 npm 发布 job 成功，工作流 MUST 停止且不创建发布记录。

#### Scenario: npm 发布成功后 GitHub 记录创建失败
- **WHEN** 某次 workflow run 的 npm 发布成功，但 tag 或 Release 创建失败
- **THEN** 在同一次 run 中重跑失败的记录创建阶段时，工作流核对 npm 版本，并使用原版本和提交补齐缺少且匹配的记录

#### Scenario: 后续 run 发现 npm 中已有版本
- **WHEN** 新的 workflow run 发现请求的版本已存在于 npm
- **THEN** 该 run 不把 registry 中的版本当作创建 tag 或 Release 的依据

#### Scenario: 原 run 的 npm job 未成功
- **WHEN** npm 发布 job 失败或被跳过，即使能从 npm 查询到该版本
- **THEN** 记录创建阶段不运行，并要求人工调查
