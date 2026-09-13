# User-installable modules

此目录保存独立交付的模块源码，不属于 TransportX 平台内置模块，也不会进入桌面应用安装包。用户通过设置页安装后，模块会复制到 `~/.transportx/traffic-agent/modules/`，可以独立启用和卸载。

| 模块 | 内容边界 | 平台依赖 |
|---|---|---|
| `shanghaidata` | 上海交通数据、数据字典、查询/治理脚本、上海数据口径与地图表达约定 | Geo |
| `shanghai-hub-traffic` | 两场三站及上海松江站的铁路、预测、出租车、功能点和网约车治理数据 | 无 |
| `traffic-assurance-knowledge` | 交通保障法规、标准、预案和案例知识，以及检索与引用流程 | Citation |
| `plot-style` | 静态图表选型、出版级样式经验、参考参数和 matplotlib 模板 | 无 |

各数据模块与 `traffic-assurance-knowledge` 彼此不依赖。数据资产放入对应模块的 `assets/databases/`，知识资产放入 `traffic-assurance-knowledge/assets/`；缺少实体资产时仍可安装模块，但设置页会显示“待配置资产”。

每个会话会装配已启用 Module 的全部 Data 与 Knowledge 资产。它们分别通过 `TRANSPORTX_DATA_ASSETS_JSON`、`TRANSPORTX_KNOWLEDGE_ASSETS_JSON` 按资产 ID 映射到各自根目录；Agent 的会话上下文会列出实际的 Skill 根目录、入口文件和资产根目录。Skill 中的 `<本 Skill 根目录>` 指该列表中的根目录，绝不等于当前任务目录，也不应写死某个用户安装路径。

平台源码不得依赖此目录中的模块 ID、Skill 或资产路径。设置页只接受自包含 Module 包；单独 Skill、Extension、Data 或 Knowledge 必须先由 `create-transportx-module` Skill 组织为一个 Module。
