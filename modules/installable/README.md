# User-installable modules

此目录保存独立交付的模块源码，不属于 TransportX 平台内置模块，也不会进入桌面应用安装包。用户通过设置页安装后，模块会复制到 `~/.transportx/traffic-agent/modules/`，可以独立启用和卸载。

| 模块 | 内容边界 | 平台依赖 |
|---|---|---|
| `shanghaidata` | 上海交通数据、数据字典、查询/治理脚本、上海数据口径与地图表达约定 | Geo |
| `traffic-assurance-knowledge` | 交通保障法规、标准、预案和案例知识，以及检索与引用流程 | Citation |
| `plot-style` | 静态图表选型、出版级样式经验、参考参数和 matplotlib 模板 | 无 |

`shanghaidata` 与 `traffic-assurance-knowledge` 彼此不依赖。数据资产放入 `shanghaidata/assets/databases/`，知识资产放入 `traffic-assurance-knowledge/assets/`；缺少实体资产时仍可安装模块，但设置页会显示“待配置资产”。

平台源码不得依赖此目录中的模块 ID、Skill 或资产路径。需要受控外部资产覆盖时，必须同时设置资产 ID 与根目录，例如 `TAU_DATA_ASSET_ID` + `TAU_DATA_ROOT`。
