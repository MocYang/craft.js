# 发布 `@deepctrls/craftjs`

本文说明如何准备版本并通过 GitHub Actions 发布到 npm。自动发布目标是 `hnldlsjzt/craft.js:main`；发布包名、版本唯一来源为 `scripts/logic-package.json`。根目录 Changesets 发布流程不适用于此包。

## 首次配置

此 fork 的 Actions 初始为未启用状态。仓库维护者先打开 [GitHub Actions](https://github.com/hnldlsjzt/craft.js/actions)，审阅页面列出的 workflow 后，按页面提示启用 fork workflows。确认左侧可见且启用了 `Publish @deepctrls/craftjs`；此时不要手动 dispatch 发布 workflow。

然后在 npm 网站进入 Packages → `@deepctrls/craftjs` → Settings → Trusted publishing，添加 GitHub Actions publisher：

- Organization or user：`hnldlsjzt`
- Repository：`craft.js`
- Workflow filename：`release.yml`（只填文件名，不带 `.github/workflows/`）
- Environment name：留空
- 在 Allowed actions 中允许直接 `npm publish`，以保留正式发布路径。npm 默认允许 `npm stage publish`，该命令无需单独勾选。

保存后确认 publisher 列表中的仓库、workflow 和 `npm publish` 权限均正确。stage 验证走 npm 默认允许的 `npm stage publish`。仓库 workflow 只在 npm 发布 job 使用 OIDC (`id-token: write`)；GitHub tag/Release job 使用其单独的 `contents: write` 权限。

## 日常发布

### 1. 评审并准备版本

先将待发布功能和修复正常评审并合入目标仓库 `hnldlsjzt/craft.js:main`，记录该源码提交 SHA。发布版本提交必须基于目标仓库 main。

选择新的稳定版本：

- patch：在仓库根目录运行 `yarn version:logic:patch`。
- minor/major：将 `scripts/logic-package.json` 的 `version` 改为新的稳定 `x.y.z`。

更新 `scripts/logic-package.README.md` 的变更摘要和包说明。不要通过修改 `packages/core/package.json` 来修改 fork 包版本，也不要手工编辑生成目录 `release/logic-craftjs`。

### 2. 运行版本预检

在仓库根目录运行：

```powershell
node scripts/check-logic-release.cjs
```

- registry 明确返回版本不存在：可以提交版本元数据和 README 变更，并 push 到 `hnldlsjzt/craft.js:main`。
- 版本已存在：停止，不得重复发布该版本；选择新版本并重新预检。workflow 对已存在版本仍执行验证，但会跳过 npm 发布、tag 和 Release。
- 网络、认证或 registry 查询出现其它错误：停止并排查。不能将查询失败当作版本不存在。

### 3. 推送发布提交并等待 workflow

将 `scripts/logic-package.json` 和 `scripts/logic-package.README.md` 的变更提交并推送至 `hnldlsjzt/craft.js:main`。只修改 workflow 等其它文件不会自动触发发布。push 会启动 `Publish @deepctrls/craftjs`：workflow 安装锁定依赖，运行测试、构建、lint、打包及 React 18.3.1 / 19.0.0 独立消费者验证；只有这些步骤成功且版本预检确认版本不存在时，才会用 OIDC 发布验证过的同一个 tarball。

如确有需要，可在仓库 Actions 页面手动运行 `Publish @deepctrls/craftjs`，但只能选择 `main`，并且它会执行完整的同一发布流程。手动 dispatch 不会绕过版本预检或验证。

在 Actions 中找到与本次 push 对应的 run，确认分支为 `main`、提交 SHA 与发布提交一致，并等待整体结果成功。只在 run 失败时打开失败 job 日志定位原因；验证任一步失败都会阻断 npm 发布。若版本预检报告已存在，确认该 run 只验证并跳过 npm 发布及 GitHub 记录创建，不要把旧版本关联到当前提交。

成功后核对 registry 和 GitHub Release：

```powershell
npm view "@deepctrls/craftjs@<version>" version --registry=https://registry.npmjs.org/
```

输出应与本次版本一致。打开 GitHub Releases，确认 `v<version>` 指向本次源码提交，且 Release 说明由 GitHub 生成。

### 4. 归档发布记录

以 `docs/releases/0.2.14-validation.md` 为模板新增 `docs/releases/<version>-validation.md`，记录：

- 发布目标、日期、源码提交 SHA、版本预检结果。
- workflow 中测试、构建、lint 和 React 18/19 消费者验证结果。
- registry tarball 地址及 SHA256。
- 未执行的浏览器或业务端验收，以及已知限制。

检查 `scripts/logic-package.README.md` 的变更摘要完整，再将发布记录提交并推送到 `hnldlsjzt/craft.js:main`。

## 失败恢复

若 npm 发布 job 成功，但 GitHub 记录 job 创建 tag 或 Release 失败，在**原 workflow run** 选择 `Re-run jobs` → `Re-run failed jobs`。记录 job 会使用原 run 的版本和触发 SHA、再次核对 npm 中存在该版本，并只补齐与原提交一致的缺失记录；它不会重新发布 npm 包。不要为恢复创建同版本提交或重新 dispatch。

若 tag 已存在但指向不同提交、Release 与 tag/提交不匹配、Release 存在但 tag 缺失，或无法确认原 run 的 npm 发布 job 成功，停止重跑并人工调查。不得强制移动 tag 或覆盖 Release。若版本预检发现 npm 中已有版本但当前 run 的 npm 发布 job 被跳过，也不能据此自动补建历史 tag 或 Release。

## 验证 Trusted Publisher（不正式发布）

若只需验证新建 Trusted Publisher 的 OIDC 身份，不要为测试正式发布版本。确认 `.github/workflows/release.yml` 已合入 `main` 且 npm 配置仍处于 Pending validation 后，在仓库 Actions 手动运行 `Publish @deepctrls/craftjs`：

1. `release_mode` 选择 `stage`。
2. `stage_version` 填一个未占用的稳定版本，例如 `0.2.17`。先确认该版本既未正式发布，也未出现在 npm 的 Staged packages 中；npm 对正式版本和 staged 版本共用版本唯一索引。工作流会用该版本号构建临时 tarball，不修改仓库里的版本元数据。
3. 等待完整验证成功。OIDC 发布 job 会对已验证的同一个 tarball 执行 `npm stage publish`；stage 模式不会执行正式 `npm publish`，也不会创建 Git tag 或 GitHub Release。
4. 在 npm Trusted Publisher 设置确认状态变为 Validated，并在 Staged packages 中确认测试包。不要批准该 stage；验证后由包维护者手动拒绝测试 stage。`npm stage reject` 需要维护者交互式 2FA。

Stage 模式只接受未占用的版本；预检发现版本已经正式发布时会失败，若版本已在其它 staged package 中占用，npm stage publish 会拒绝重复版本。push 版本元数据仍走正常正式发布模式，workflow dispatch 的默认模式也是 `publish`，因此手动运行时必须明确选 `stage` 才不会正式发包。

## 本地验证（可选）

在发版前也可按 CI 命令本地复现验证。任一步失败都应先排查，不能继续发布：

```powershell
node .yarn/releases/yarn-3.6.3.cjs install --immutable --mode=skip-build
node --test scripts/check-logic-release.test.cjs
node .yarn/releases/yarn-3.6.3.cjs test --runInBand
```

```powershell
Push-Location packages/layers
node ../../node_modules/typescript/bin/tsc --skipLibCheck --emitDeclarationOnly --incremental false
node ../../node_modules/rollup/dist/bin/rollup -c rollup.config.js
Pop-Location
npm run lint
```

CI 的发布验证是完整结果的最终依据；浏览器端和业务仓库替换依赖后的验收应按改动风险另行记录。
