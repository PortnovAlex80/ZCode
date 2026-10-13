@echo off
rem R-08: fork 的唯一根级安装包构建入口（Windows x64，复用 upstream electron-builder/NSIS 管线）。
rem 两种模式：
rem   Build-Installer.cmd          完整路径：prepare（CLI agent bundle + native 工具）-> 生产构建（带 receipt）-> 打包
rem   Build-Installer.cmd fast     快速路径：先机械校验缓存（receipt、agent bundle、native 工具），通过才直接打包
rem 本脚本只编译和打包：绝不启动安装包、绝不安装、绝不发布，也不触碰已安装的 ZCODE 或用户 profile。
setlocal EnableExtensions
cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=full"
if /i "%MODE%"=="full" goto :mode_ok
if /i "%MODE%"=="fast" goto :mode_ok
echo [Build-Installer] unknown mode "%MODE%" - expected: full ^| fast
exit /b 2
:mode_ok

rem ---- 固定发布身份与 fork 安全更新策略（R-10）----
rem ZCODE_ENV=production：安装包使用正式产品身份（ZCode / dev.zcode.app）与生产 provider 配置，
rem 与“只维护一个产品、复用本机正常 profile”的决策一致。
set "ZCODE_ENV=production"
rem ZCODE_AUTO_UPDATE=0：显式把打包内自动更新编译为关闭（scripts/build-time-config.mjs 里
rem 显式环境变量优先于私有默认值）。官方 stable feed 分发的是官方安装包，自动更新会静默覆盖
rem fork 功能，因此 fork 发布包必须 fail-closed：initAutoUpdater({enabled:false}) 会清掉轮询，
rem 手动检查也在模块内拒绝（packages/desktop/src/main/autoUpdater.ts）。
set "ZCODE_AUTO_UPDATE=0"
rem Preview 身份与可选打包/签名开关一律清空：发布不使用测试身份，不带浏览器导入 helper，
rem 不假设任何签名凭据（签名为可选的本地配置，绝不是默认）。
set "ZCODE_PREVIEW_IDENTITY="
set "ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT_HELPER="
set "ZCODE_ENABLE_WINDOWS_SIGN="
set "ZCODE_ENABLE_MAC_SIGN="
rem 桌面 NSIS 安装包不消费 mock-cdn 远程预编译资产（与 upstream Windows CI 同语义，
rem 见 packages/desktop/scripts/prepare-runtime-assets.mjs 的注释）；远程 SSH/WSL 运行时
rem 走运行时下载，不进安装包。
set "ZCODE_SKIP_REMOTE_ASSETS=1"
rem 目标固定为 Windows x64（R-08 只承诺这一条发布管线）。
set "ZCODE_TARGET_OS=win"
set "ZCODE_TARGET_ARCH=x64"
rem electron-builder 只在识别为 CI 环境时才可能自动 publish；清空 CI 保证语义恒为“仅构建”。
set "CI="

set "START_TIME=%TIME%"
echo [Build-Installer] mode=%MODE% target=win/x64 identity=production auto-update=off started %START_TIME%
echo [Build-Installer] pinned env: ZCODE_ENV=%ZCODE_ENV% ZCODE_AUTO_UPDATE=%ZCODE_AUTO_UPDATE% ZCODE_SKIP_REMOTE_ASSETS=%ZCODE_SKIP_REMOTE_ASSETS% ZCODE_TARGET_OS=%ZCODE_TARGET_OS% ZCODE_TARGET_ARCH=%ZCODE_TARGET_ARCH% CI=[%CI%]

rem ---- 工具链门槛：Node 24+（mise 钉 24.14.0；shell 偏差如实记录在 README）----
set "STEP=toolchain check (node 24+)"
node scripts\assert-node-version.mjs
if errorlevel 1 goto :fail

rem ---- 预检：上面固定的环境真正落到打包配置里；flavor 或自动更新不符合预期就拒绝构建 ----
set "STEP=fork-safe preflight (product identity + auto-update off)"
node --input-type=module -e "import { resolveBuildTimeConfig } from './scripts/build-time-config.mjs';import { resolveDesktopProductIdentity } from './packages/desktop/scripts/desktop-product-identity.mjs';const c=await resolveBuildTimeConfig(process.env);const i=resolveDesktopProductIdentity(process.env);if(c.autoUpdateEnabled){console.error('[Build-Installer] REFUSED: packaged auto-update would be enabled');process.exit(1);}if(i.flavor!=='production'){console.error('[Build-Installer] REFUSED: product flavor='+i.flavor);process.exit(1);}console.log('[Build-Installer] preflight ok: '+i.productName+' appId='+i.appId+' flavor=production autoUpdateEnabled=false');"
if errorlevel 1 goto :fail

if /i "%MODE%"=="fast" goto :validate_cache

rem ---- 完整路径：依赖缺失时仅做 frozen 安装（绝不刷新 lockfile）----
if exist "node_modules\.pnpm\lock.yaml" goto :prepare
set "STEP=frozen dependency install"
echo [Build-Installer] node_modules missing - running pnpm install --frozen-lockfile
call pnpm install --frozen-lockfile
if errorlevel 1 goto :fail

:prepare
rem ---- 第 1/3 步：runtime 资产（zcode-cli agent bundle、ugrep/ripgrep、node-pty prebuild 复用安装产物）----
rem 修复依据：pnpm 在 Windows 上是 .cmd shim；批处理里不加 call 会把控制权“链”给 shim，
rem 本脚本后续步骤不再执行（且环境钉住值到不了子进程），还把 pnpm 的退出码当成整个脚本的成败。
set "STEP=prepare runtime assets (agent CLI bundle + native tools)"
echo [Build-Installer] step 1/3: prepare runtime assets
call pnpm --filter @zcode/desktop prepare:runtime-assets
if errorlevel 1 goto :fail

rem ---- 第 2/3 步：生产构建并写 receipt（sources fingerprint + 输出哈希，供 fast 路径校验）----
rem 先 prepare 再 build：receipt 的源指纹覆盖 packages/ 全树，资产目录先落盘，receipt 才能代表完整状态。
set "STEP=production build with receipt"
echo [Build-Installer] step 2/3: production build with receipt
node scripts\spec-harness-production.mjs build
if errorlevel 1 goto :fail
goto :package

:validate_cache
rem ---- 快速路径缓存校验：receipt 有效 + 已暂存 agent bundle 与 CLI dist 逐字节一致 + native 工具在位 ----
set "STEP=cache validation"
node --input-type=module -e "import { createHash } from 'node:crypto';import { existsSync, readFileSync } from 'node:fs';import { validateProductionBuild } from './scripts/spec-harness-production.mjs';const problems=[];try{await validateProductionBuild();console.log('[validate] production receipt: sources and outputs match');}catch(e){problems.push(String(e.message||e));}const cli='apps/zcode-cli/packages/cli/dist/zcode.cjs';const staged='packages/desktop/bundled-agents/win32-x64/glm/zcode.cjs';const sha=(p)=>createHash('sha256').update(readFileSync(p)).digest('hex');if(!existsSync(cli)){problems.push('CLI bundle missing: '+cli);}else if(!existsSync(staged)){problems.push('staged agent bundle missing: '+staged);}else if(sha(cli)!==sha(staged)){problems.push('staged agent bundle differs from CLI dist: '+staged);}for(const t of ['ugrep/ugrep.exe','ripgrep/rg.exe']){const p='packages/desktop/bundled-tools/win32-x64/'+t;if(!existsSync(p))problems.push('native tool missing: '+p);}if(problems.length){for(const m of problems)console.error('[validate] '+m);console.error('[validate] cached rebuild NOT possible - run a full Build-Installer.cmd first');process.exit(1);}console.log('[validate] cached rebuild allowed: receipt, agent bundle and native tools are current');"
if errorlevel 1 goto :fail

:package
rem ---- 第 3/3 步：electron-builder NSIS win/x64（自带运行时闭包校验、native 边界校验与体积审计）----
rem --skip-prepare --skip-build：构建产物与资产已由上面两步产出并被 receipt 校验，避免重复全量构建。
set "STEP=electron-builder NSIS packaging"
echo [Build-Installer] step 3/3: electron-builder NSIS packaging
call pnpm bundle:desktop -- --os win --arch x64 --skip-prepare --skip-build
if errorlevel 1 goto :fail

rem ---- 结果报告：产物路径、upstream/fork 版本、源修订、SHA-256 ----
set "STEP=build report"
node --input-type=module -e "import { createHash } from 'node:crypto';import { readFileSync, readdirSync, statSync } from 'node:fs';import { execSync } from 'node:child_process';import { resolve } from 'node:path';const dist='packages/desktop/dist';let newest=null;try{for(const name of readdirSync(dist)){const lower=name.toLowerCase();if(!lower.endsWith('.exe'))continue;if(!/-win-x64[._-]/.test(lower))continue;const full=resolve(dist,name);const m=statSync(full).mtimeMs;if(!newest||m>newest.m)newest={full,name,m};}}catch(e){}if(!newest){console.error('[installer] no Windows x64 NSIS artifact found under '+dist);process.exit(1);}const root=JSON.parse(readFileSync('package.json','utf8'));let meta={};try{meta=JSON.parse(readFileSync('packages/desktop/out/metadata/build-meta.json','utf8'));}catch(e){}let rev='unknown';try{rev=execSync('git rev-parse HEAD').toString().trim();}catch(e){}const sha=createHash('sha256').update(readFileSync(newest.full)).digest('hex');const size=statSync(newest.full).size;console.log('=== Build-Installer result ===');console.log('Artifact        : '+newest.full);console.log('Artifact size   : '+size+' bytes');console.log('SHA-256         : '+sha);console.log('Upstream base   : '+root.version+' (upstream tag v3.15.1 = aac4755666d09fdcd70272fcf063c077a639015f)');console.log('Fork revision   : '+rev.substring(0,8)+' ('+rev+')');console.log('Packaged version: '+(meta.appVersion||root.version)+'  commit='+(meta.buildCommitId||'unknown')+'  built='+(meta.buildTime||'unknown'));console.log('electron-builder: '+(meta.electronBuilderVersion||'unknown'));"
if errorlevel 1 goto :fail

echo.
echo This was a build-only run: the installer was NOT launched, NOT installed and NOT published.
echo Desktop package only - Office/CAD host setup is separate:
echo   - Word/Excel task pane: opt-in document gateway pairing after the desktop app is installed
echo     (see docs\spec-harness\DOCUMENT-HOSTS.md); the desktop installer alone does not sideload it.
echo   - AutoCAD plug-in: manual NETLOAD deployment of prototypes\autocad-preview (never launched here).
echo Fork-safe updates (R-10): packaged auto-update is compiled OFF (ZCODE_AUTO_UPDATE=0);
echo official installer remains an explicit fallback, upstream changes arrive via reviewed merge + rebuild.
echo [Build-Installer] mode=%MODE% finished %TIME% (started %START_TIME%)
exit /b 0

:fail
echo [Build-Installer] FAILED at step: %STEP%
echo [Build-Installer] nothing was launched, installed or published.
exit /b 1
