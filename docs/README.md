# 项目文档索引

文档按“架构—功能方案—运行交接—专项说明—图片资产”组织。README 负责产品入口，这里负责工程入口。

| 文档 | 用途 | 维护时机 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统边界、依赖方向、目录与资产规则 | 模块职责或构建方式改变时 |
| [GIS_WEB_VISUALIZATION_TECHNICAL_PLAN.md](./GIS_WEB_VISUALIZATION_TECHNICAL_PLAN.md) | GIS 协议、Runtime、安全与演进方案 | GIS 契约或能力阶段改变时 |
| [REACT_UI_MIGRATION_PLAN.md](./REACT_UI_MIGRATION_PLAN.md) | React、shadcn/ui、Radix 与 Motion 迁移评估和实施路线 | UI 技术栈或迁移阶段改变时 |
| [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md) | 当前状态、运行方式、常见问题 | 每个里程碑完成后 |
| [MOBILE.md](./MOBILE.md) | 移动端相对桌面端的适配差异 | 移动布局或交互改变时 |
| [images/](./images/) | README 和工程文档使用的截图 | UI 发生明显变化时 |

维护规则：

- 架构事实只在 `ARCHITECTURE.md` 定义，其他文档引用它，不复制另一套目录说明。
- GIS 的详细协议只在 GIS 技术方案中维护，README 仅保留使用入口。
- 截图使用小写英文和连字符命名；过期截图直接替换，不保留多份 `final-v2` 文件。
- 临时分析、会话文件、GeoJSON 发布缓存和编译产物不进入 `docs/`。
