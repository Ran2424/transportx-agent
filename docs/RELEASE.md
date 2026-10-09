# 版本开发与发布规范

本项目持续维护。每个版本有一份开发记录、一个源码提交和按平台保存的验收证据；功能合并不等于安装包已经发布。原始更新设计见 [软件更新计划](软件更新功能开发%20PLAN.md)。

## 版本与范围

采用 SemVer `MAJOR.MINOR.PATCH`。新增向后兼容能力升 minor；修复而不改变契约升 patch；不兼容的 API、模块契约或数据格式升 major。文档和开发工具变更记入 Unreleased，不单独要求发客户端版本。Module 独立遵守相同规则，平台版本变化不自动提高 Module 版本。

新版本从当前 main 建 `codex/<feature>` 分支。先复制 [版本开发模板](releases/TEMPLATE.md) 为 `docs/releases/<version>.md`，写清用户问题、范围、非目标、验收条件、兼容性和依赖。每项验收都有对应行为和证据，不以“测试通过”代替用户流程验证。保持工作区中的用户文件，不用 reset 或删除文件清理 main。

本次新增主程序更新能力，下一目标版本为 **3.23.0**。版本号在发布准备时同步 `package.json`、锁文件根版本及 `src/server/config.ts`；开发内容先进入 CHANGELOG 的 Unreleased。正式发布时移入带 `YYYY-MM-DD` 日期的版本段，采用 Added / Changed / Fixed / Security / Removed，每种分类只出现一次。已发布版本号和带版本号的资产不可复用或覆盖。

## 状态与合并门槛

版本状态依次为 Planned → In development → In review → Validated → Released。发现验收失败时回到 In development；暂停或取消需记录原因。macOS 和 Windows 分别记录 `not tested / passed / failed / published`，一个平台通过不能证明另一平台可更新。

- 开始开发：用户问题、验收条件和版本范围已写入记录。
- 进入评审：PR 说明最终行为、改动边界和测试结果；预算、类型和范围内检查通过，失败项说明原因。
- 验证完成：签名、首次手动迁移、连续两个含更新器版本之间的安装、数据保留、普通退出不安装均在对应系统有证据。
- 发布：源码与版本固定，资产哈希与验收记录一致，OSS 文件可匿名 HEAD/Range 下载，最后更新清单；GitHub Release 和官网使用同一组版本、说明、大小与链接。

开发检查按项目约定执行 `npm run test:budget`、`npm run typecheck`、`npm test`、`npm run test:web` 和本机可执行的平台检查。套件总数保持 40 以内，更新测试合并到 desktop-runtime / desktop-launch 现有套件。真实升级单独验收；平台启动冒烟不证明升级成功。

## 构建与更新发布

`platform-profile.mjs` 声明更新目录和产物命名，electron-builder 从该声明生成 `app-update.yml` 与 `latest*.yml`。Mac 同时生成 DMG 和 ZIP；Windows 使用 NSIS。应用只在打包后检查更新，默认不下载、不在普通退出时安装。说明来自 CHANGELOG，渲染为纯文本。

正式包要求 Developer ID 与公证，或 Authenticode 与可信时间戳。缺少证书时可以构建内部测试包、验证代码和 UI，但禁止开放正式清单。当前 v3.22.0 没有更新器，需要用户手动安装支持更新的首版。

```bash
# 在各自系统上构建，同一源码提交；不要在 Mac 上交叉打 Windows。
npm run desktop:pack

# 校验明确的版本和平台文件；默认不上传。
npm run release:oss -- --version 3.23.0 --platform mac
npm run release:oss -- --version 3.23.0 --platform win

# 对应平台真实升级验收完成后才发布。
npm run release:oss -- --version 3.23.0 --platform mac --publish
```

发布工具要求 ossutil 2.x，从本地配置或环境读取 RAM 身份，凭据不得放入仓库。只允许向 `transportx-agent` Bucket 的 releases/updates 前缀发布。发布时要求 `release/acceptance-<version>-<profile>.json`，格式见 [验收模板](releases/acceptance.template.json)。此记录是人工验收证据索引，不能通过填 `true` 替代实际签名与升级测试；哈希必须来自已验收资产。

工具预检清单、相对文件名、版本、架构、大小、SHA-512 和说明。上传仅使用清单引用的资产及其构建 blockmap，不递归扫描 release。匿名访问或上传失败时中止，文件全部验证后才替换 latest 清单。版本文件长缓存，latest 清单 no-cache。记录保存在 `release/publication-<version>-<profile>.json`，包含旧清单用于撤回。每个平台的发布任务串行执行；两个平台的发布不是原子事务。

发布完成还要在已安装客户端检查线上版本并完成升级，记录日志、应用版本和用户数据目录验证结果。GitHub Release、官网和手动下载目录沿用 [设计计划第 9 节](软件更新功能开发%20PLAN.md) 的发布要求。

## 升级与维护证据

至少记录旧/新版本、系统与架构、签名身份、源码 SHA、资产 SHA-256、操作步骤、结果与日志位置。升级前备份测试用户目录，逐项核对会话、模型、认证、工作区、settings、独立模块及旧会话精确模块版本；不要将认证内容写进证据。测试忙碌拒绝、断网重试、校验失败、普通退出与安装后无残留 Host/Pi 子进程。

无数据格式变化时不引入迁移层。有格式变化时单独定义版本化迁移、备份、原子替换和失败恢复，并评估人工降级可读性。坏版本撤回清单只能阻止尚未升级的用户发现；已升级用户使用更高版本修复。保留历史包供人工恢复，首版不承诺自动回滚。

每次发布指定维护责任人和问题反馈入口，记录更新失败、证书到期与 OSS 流量费用的跟进项。仅在用户请求监控时建立自动化，不自动把维护规范变成周期任务。
