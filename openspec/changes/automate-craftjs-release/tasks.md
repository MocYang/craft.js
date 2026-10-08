## 1. 先由发布人启用 Actions 并配置 npm Trusted Publisher

- [x] 1.1 登录 GitHub，打开 `https://github.com/hnldlsjzt/craft.js/actions`。若出现黄色 fork 提示 `Workflows aren't being run on this forked repository`，先确认页面列出的 workflow 文件已审阅，再点击 `I understand my workflows, go ahead and enable them`。此操作会启用 fork 中列出的工作流；确认提示消失，左侧可见 `Publish @deepctrls/craftjs` 且 workflow 已启用。此时不要手动运行发布 workflow。
- [x] 1.2 登录 npm 网站，进入 Packages → `@deepctrls/craftjs` → Settings → Trusted publishing，添加 GitHub Actions publisher；填写 Organization or user=`hnldlsjzt`、Repository=`craft.js`、Workflow filename=`release.yml`。文件名只填 `release.yml`，不要填 `.github/workflows/` 路径；Environment name 留空，因为 workflow 不使用 GitHub Environment。现有配置已过期，删除后重建；npm 要求新配置须在 2 天内首次成功发布才能验证并生效。
- [x] 1.3 在 npm Trusted Publisher 配置的 Allowed actions 中允许直接 `npm publish`，以保留正式发布路径；npm 对新 Trusted Publisher 默认允许 `npm stage publish`，无需单独勾选。保存后确认 publisher 的仓库、workflow 和直接发布权限正确。若已有配置过期或字段错误，按 npm 页面规则删除后重新添加。

## 2. 修改发布工作流

- [x] 2.1 修改 `.github/workflows/release.yml` 的 push 触发器：当前只监听 `main`，但 `paths` 同时包含 `scripts/logic-package.json` 和 `.github/workflows/release.yml`；删除 workflow 文件自身的 path 项，使自动 push 只由 `main` 上的版本元数据变更触发。保留 `workflow_dispatch` 和 job 级 `hnldlsjzt/craft.js:main` 限制；检查 YAML 中的 `branches`、`paths` 和仓库/ref 条件。
- [x] 2.2 保留验证 job 的版本预检、锁文件安装、测试、构建、lint、打包及 React 18/19 独立消费者验证；确保它上传通过验证的 tarball，版本已存在时输出仅验证结果，任一验证失败都会阻断后续发布；检查 job 依赖和产物上传配置。
- [x] 2.3 调整 npm 发布 job：仅在版本预检确认版本不存在且验证成功时运行；从验证 job 下载并发布同一个 tarball，继续使用 npm Trusted Publishing；确认 `id-token: write` 只授予该 job，且已存在版本不会重复发布。
- [x] 2.4 新增 GitHub 记录 job：仅在同一 workflow run 的 npm 发布 job 成功后运行，使用该 run 的版本和触发提交 SHA；再次确认 npm 中存在该版本，不从新 run 或后续提交推断发布来源。
- [x] 2.5 在 GitHub 记录 job 中创建或核对 `v<version>` tag：不存在时创建在触发 SHA 上；已存在且指向相同 SHA 时复用；指向其他 SHA 时失败且不移动 tag。检查匹配和冲突两种情况。
- [x] 2.6 在 GitHub 记录 job 中创建或核对对应 GitHub Release：新建时使用 GitHub 自动生成说明；已存在且与 tag/触发 SHA 匹配时复用；目标冲突时失败且不覆盖。确保 tag 创建后 Release 创建失败时可在原 run 中单独重跑记录 job。
- [x] 2.7 将 `contents: write` 只授予 GitHub 记录 job，将 `id-token: write` 只授予 npm 发布 job；检查其它 job 没有这两项写权限。

## 3. 更新发布操作文档

- [x] 3.1 更新 `docs/manual-release.md`，说明当前 Actions 未启用的起始状态、首次启用与 npm Trusted Publisher 配置入口和字段、日常版本准备、版本预检结果处理、目标仓库提交/推送、workflow 运行与最终结果检查、registry 核验、发布记录归档及失败恢复；说明手动 `workflow_dispatch` 会执行同一发布流程，只在 `main` 上且确有需要时使用。对照 `.github/workflows/release.yml` 检查文档一致性。

## 4. 验证工作流与文档变更

- [x] 4.1 按 CI 使用锁定 Yarn 安装依赖并运行发布预检测试和仓库测试：`node .yarn/releases/yarn-3.6.3.cjs install --immutable --mode=skip-build`、`node --test scripts/check-logic-release.test.cjs`、`node .yarn/releases/yarn-3.6.3.cjs test --runInBand`；记录结果，失败时不得继续发布。
- [x] 4.2 在 `packages/layers` 执行 CI 中的 TypeScript 声明构建和 Rollup 构建，再运行 `npm run lint`；确认命令成功，失败时不得继续发布。
- [ ] 4.3 验证 CI 打包、React 消费者与同一 tarball 发布链路。
  - [x] 4.3.1 本地设置 `RELEASE_MODE=stage`、`RELEASE_VERSION=0.2.17`，运行 `scripts/prepare-logic-release.cjs` 并对生成目录执行 `npm pack`；检查 tarball 内包名和版本为 `@deepctrls/craftjs@0.2.17`。结果：成功，生成 `release/deepctrls-craftjs-0.2.17.tgz`。
  - [x] 4.3.2 使用该 tarball 运行 `scripts/verify-logic-package.cjs`，验证 React 18.3.1。本次进程代理改为 `127.0.0.1:7897` 后安装成功；修正验证脚本中已过时的 DOM 注册通知断言，并确认节点数据变更仍触发通知；独立 CJS、ESM、声明、编辑权限和历史验证全部通过。
  - [x] 4.3.3 使用该 tarball 运行 `scripts/verify-logic-package.cjs`，验证 React 19.0.0。独立 CJS、ESM、声明、编辑权限和历史验证全部通过。
  - [ ] 4.3.4 在合入后的 CI 中确认 React 18/19 验证通过，并确认上传 artifact 与正式发布或 stage publish 下载的是同一个已验证 tarball；stage-only 不创建 tag/Release。
- [ ] 4.4 验证工作流分支、版本门禁、权限和发布记录恢复。
  - [x] 4.4.1 解析 YAML，并静态断言 push 触发范围、仓库/main 限制、publish job 依赖和门禁、stage/publish 命令分支、GitHub Release job 条件，以及 `id-token: write` / `contents: write` 权限范围；通过。
  - [x] 4.4.2 运行 `node --test scripts/check-logic-release.test.cjs`：新版本、已存在版本、registry 错误 fail-closed、无效版本和 stage 版本输入检查共 5 项通过。
  - [ ] 4.4.3 演练 stage 版本已正式发布、已被其他 staged package 占用、验证失败及 stage 成功时的工作流结果；尚未连接 npm/GitHub CI 实测。
  - [ ] 4.4.4 演练 Git tag/Release 匹配时复用、目标冲突时失败且不覆盖，以及 npm 发布成功后记录 job 失败并在原 run 重跑恢复。
  - [x] 4.4.5 运行 `openspec validate automate-craftjs-release --strict --no-interactive`；通过。相关文件 Prettier 检查、YAML 解析与 `git diff --check` 也通过。
- [ ] 4.5 在目标仓库真实验证 npm Trusted Publisher stage 流程。
  - [ ] 4.5.1 完成任务 5.1 的评审与合入，并确认 `hnldlsjzt/craft.js:main` 已包含本次 workflow 和文档。
  - [ ] 4.5.2 确认测试版本未正式发布，也未被其他 staged package 占用。
  - [ ] 4.5.3 在 `release.yml` 手动选择 `stage` 和未占用版本，等待构建、React 18/19 验证及 OIDC `npm stage publish` 全部成功。
  - [ ] 4.5.4 确认 Trusted Publisher 状态变为 `Validated`，测试包处于 staged 状态，且没有正式 npm 版本、Git tag 或 GitHub Release。
  - [ ] 4.5.5 不批准测试包；由包维护者通过 npm UI/CLI 和交互式 2FA 拒绝该 staged package。

## 5. 评审并合入自动化改动

- [ ] 5.1 将工作流与文档改动提交 Pull Request，完成正常代码评审并合入 `hnldlsjzt/craft.js:main`；确认目标仓库 `main` 包含 `.github/workflows/release.yml` 和 `docs/manual-release.md` 的变更。

## 6. 每次发布由发布人执行

- [ ] 6.1 先确认待发布功能与修复已通过评审并合入 `hnldlsjzt/craft.js:main`，记下源码提交 SHA。
- [ ] 6.2 选择新的稳定版本：patch 版运行 `yarn version:logic:patch`；minor/major 版将 `scripts/logic-package.json` 的版本改成新的 `x.y.z`。更新 `scripts/logic-package.README.md` 的变更摘要和包说明，并检查发布版本信息。
- [ ] 6.3 在仓库根目录运行 `node scripts/check-logic-release.cjs`。registry 明确返回版本不存在时继续；版本已存在时停止并选择新版本；网络、认证或 registry 查询出现其它错误时停止，不得把查询失败当作版本不存在。
- [ ] 6.4 将版本元数据和 README 变更提交，并推送到 `hnldlsjzt/craft.js:main`；确认该 push 触发 `Publish @deepctrls/craftjs` workflow，且运行记录的分支和提交 SHA 正确。
- [ ] 6.5 在 GitHub 仓库 Actions → `Publish @deepctrls/craftjs` 查看本次 push 对应的 run，等待 run 结束并确认总体结果为成功；仅当 run 失败时再打开失败 job 日志定位原因。版本门禁、各验证步骤及 job 依赖由工作流自动执行，发布人不需要每次逐项人工复核这些条件。
- [ ] 6.6 若本次版本预检发现 npm 中已存在该版本，确认该 run 只验证并跳过 npm 发布、tag 和 Release；不要将已有版本自动关联到当前提交，也不要重复发同一版本。
- [ ] 6.7 在 PowerShell 运行 `npm view "@deepctrls/craftjs@<version>" version --registry=https://registry.npmjs.org/`，确认返回的版本与本次发布一致；打开 GitHub Releases，确认 `v<version>` 指向本次源码提交且 Release 说明已生成。
- [ ] 6.8 按 `docs/releases/0.2.14-validation.md` 创建 `docs/releases/<version>-validation.md`，记录发布目标、日期、源码提交、预检结果、测试/构建/lint、React 18/19 消费者验证、registry tarball 地址及 SHA256、未执行的验收和已知限制；确认 README 变更摘要完整，并将发布记录提交到 `hnldlsjzt/craft.js:main`。

## 7. 发布失败时由发布人恢复

- [ ] 7.1 若 npm 发布 job 成功但 GitHub 记录 job 失败，进入原 workflow run，选择 `Re-run jobs` → `Re-run failed jobs`；不要新建同版本提交或重新 dispatch。确认重跑使用原版本和触发 SHA、npm 版本仍可查询，并且没有重新发布 npm 包。
- [ ] 7.2 若已有 tag 指向不同提交、Release 与 tag/提交不匹配，或无法确认原 run 的 npm 发布 job 成功，停止重跑并人工调查；不得强制移动 tag 或覆盖 Release，确认冲突原因并决定后续处置后再继续。
