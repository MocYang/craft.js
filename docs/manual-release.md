# 手动发布 `@deepctrls/craftjs`

本文只说明本地手动发布流程，不执行发布。命令在 Windows PowerShell 下从仓库根目录运行。

## 发布对象与版本

- npm 发布对象只有 `@deepctrls/craftjs`。根目录是保留上游 workspace 结构的 monorepo，发布目录由 `scripts/prepare-logic-release.cjs` 生成。
- 发布包名和版本以 `scripts/logic-package.json` 为准。不要改 `packages/core/package.json` 的上游 workspace 版本；`@craftjs/utils` 会作为内部依赖打进 Core 包，不需要为内部改动单独发包。
- `scripts/logic-package.README.md` 会成为 tarball 内的 `README.md`。发布前更新本次变更和安装示例。
- `.github/workflows/release.yml` 会在 `main` 上 `scripts/logic-package.json` 改动时自动启动，也支持 Actions 手动运行。它先验证，再发布已经验证的同一个 tarball。手动发包后再推送版本变更时，workflow 会识别版本已存在并跳过重复发布。

## 1. 准备版本

先把要发布的源码和测试整理到可审阅的提交，确认工作区没有不相关改动。发布记录使用该源码提交号。

截至 2026-09-28，仓库元数据是 `0.2.15`，版本预检确认它已存在于 npm，不能重发。下一次 patch 版本应先运行 `yarn version:logic:patch`，得到 `0.2.16` 后重新预检；实际发布当天仍以 registry 检查结果为准。

检查 `scripts/logic-package.json` 当前版本：

```powershell
Get-Content scripts/logic-package.json
node scripts/check-logic-release.cjs
```

发布新的 patch 版本时运行：

```powershell
yarn version:logic:patch
```

该命令只把 `scripts/logic-package.json` 的 `x.y.z` patch 位加一。发布 minor/major 版本时，手动只改这个文件中的 `version`，保持稳定版 `x.y.z` 格式。然后再运行 `node scripts/check-logic-release.cjs`：

- registry 返回 404：该版本尚不存在，可以继续验证。
- registry 返回 200：该版本已发布，不能覆盖；停止发布，选择一个新版本。workflow 对已存在版本只跑验证并跳过发布。
- 网络、认证或 registry 返回其它错误：停止操作。脚本会 fail closed，不能把查询失败当作版本不存在。

查看版本对应的现有发布记录也可用：

```powershell
$version = (Get-Content scripts/logic-package.json -Raw | ConvertFrom-Json).version
npm view "@deepctrls/craftjs@$version" version dist.tarball --registry=https://registry.npmjs.org/
```

## 2. 安装依赖并验证源码

使用仓库锁定的 Yarn 版本和 lockfile：

```powershell
node .yarn/releases/yarn-3.6.3.cjs install --immutable --mode=skip-build
node scripts/check-logic-release.test.cjs
node .yarn/releases/yarn-3.6.3.cjs test --runInBand
```

构建 layers 供仓库 lint 解析，再运行全仓 lint：

```powershell
Push-Location packages/layers
node ../../node_modules/typescript/bin/tsc --skipLibCheck --emitDeclarationOnly --incremental false
node ../../node_modules/rollup/dist/bin/rollup -c rollup.config.js
Pop-Location
npm run lint
```

任一命令失败都先修复或记录原因，不继续发布。浏览器端验收、业务仓库替换依赖后的验收不由上述 Jest、build 或 lint 结果代替；按本次改动风险另行记录。

## 3. 生成并检查将要发布的 tarball

准备脚本会构建 utils 和 core 的声明及运行时代码，生成 `release/logic-craftjs`，把匹配版本的 utils 放入 `internal/utils`，重写 Core 的 CJS、ESM 和声明入口，并复制发布 README。该目录是生成物，不要手工修改。

```powershell
node scripts/prepare-logic-release.cjs
$version = (Get-Content scripts/logic-package.json -Raw | ConvertFrom-Json).version
npm pack ./release/logic-craftjs --pack-destination release
$tarball = "release/deepctrls-craftjs-$version.tgz"
if (-not (Test-Path $tarball)) { throw "Missing release tarball: $tarball" }
```

检查生成包的名字、版本、README、依赖和文件：

```powershell
$manifest = Get-Content release/logic-craftjs/package.json -Raw | ConvertFrom-Json
if ($manifest.name -ne '@deepctrls/craftjs' -or $manifest.version -ne $version) { throw 'Unexpected package name or version' }
if ($manifest.dependencies.'@craftjs/utils') { throw 'Utilities must be bundled inside this package' }
tar -tf $tarball
Get-FileHash $tarball -Algorithm SHA256
```

然后用独立消费者验证 tarball，而不是只验证 workspace 源码：

```powershell
node scripts/verify-logic-package.cjs $tarball 18.3.1
node scripts/verify-logic-package.cjs $tarball 19.0.0
```

验证脚本会临时安装该 tarball 与指定 React 版本，检查 CJS、ESM、声明文件、编辑权限和历史行为。记录测试结果及 SHA256；验证失败时不要发布。

## 4. 登录并发布已验证的 tarball

确认使用官方 npm registry，并确认登录身份拥有 `@deepctrls` 发布权限：

```powershell
npm whoami --registry=https://registry.npmjs.org/
```

未登录时由包维护者在交互终端完成 `npm login --registry=https://registry.npmjs.org/`，不要把 token 写进命令、文档或仓库文件。登录后重新运行 `npm whoami`。

发布刚才验证过的同一个 tarball：

```powershell
npm publish $tarball --access public --registry=https://registry.npmjs.org/
```

发布是不可覆盖的 registry 写入。确认版本预检为 404、包名/版本正确、独立消费者验证通过后再执行。手动本地发布不带 GitHub Actions OIDC provenance；若发布策略要求 provenance，改走 `.github/workflows/release.yml`，不要混用两种发布动作。

## 5. 发布后确认并归档

核对 registry 元数据和下载地址：

```powershell
npm view "@deepctrls/craftjs@$version" version dist.tarball --registry=https://registry.npmjs.org/
```

以 `docs/releases/0.2.14-validation.md` 为模板，新建 `docs/releases/<version>-validation.md`，记录：

- 发布目标、日期、源码提交号、版本预检结果。
- Jest、lint、声明/CJS/ESM 构建、两种 React 独立消费者结果。
- npm 发布命令结果、registry 返回的 tarball 地址、已发布 tarball 的 SHA256。
- 未执行的浏览器/业务端回归及其它已知限制。

最后更新 `scripts/logic-package.README.md` 的变更说明，并提交发布记录。版本已经存在时不能再次发布同版本；修复应增加版本后重走流程。

## 6. 业务仓库切换版本

发布成功后，在业务仓库将 `@craftjs/core` alias 和 pnpm override 一起更新到已发布的精确版本，再运行 `pnpm install --lockfile-only` 或 `pnpm install` 更新 lockfile并检查解析结果。新版本已含所需改动后，删除对应 `patchedDependencies` 项和本地 patch 文件；不要同时保留旧版本覆盖或重复的 `@deepctrls/craftjs` 依赖。

业务源码仍直接从 `@craftjs/utils` 导入 `ROOT_NODE`、`getRandomId` 时，保留业务自身的 `@craftjs/utils` 依赖。这里的路径订阅实现属于 Core 内部打包的 utils，不需要单独发布 `@craftjs/utils`。

验证业务 lockfile 中 `@craftjs/core`、`@craftjs/layers` 等 peer 最终只解析到同一份 `@deepctrls/craftjs`，再执行业务侧针对性测试和手工页面验收。先在业务分支验证，再合并版本升级。
