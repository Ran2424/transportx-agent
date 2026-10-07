# TransportX 网页使用文档

独立静态文档站，入口为 `index.html`。内容依据桌面版 3.22.0 的源码、模块契约和真实界面编写。

在浏览器中直接打开 `index.html` 即可阅读，也可通过静态 HTTP 服务预览。部署时将本目录整体作为站点根目录，无需构建、Node 依赖或 Agent Host。

- `guide.js`：文档内容、导航、页内目录、搜索、图片预览和示例提问复制。
- `styles.css`：桌面三栏布局与移动端导航。
- `assets/`：产品截图与标识。模型接入、模块安装和新建任务截图来自本机桌面应用；地图与报告图片取自项目现有产品截图。
- 产品介绍页使用项目现有的 68 秒英文演示视频，其余操作文档保留界面截图。

参考 DeepStudent 的文档信息结构与三栏布局，文案和图片均对应 TransportX。未复制其产品功能或配置流程。

此站点提供使用说明，不在网页中保存 API Key，也不调用模型。安装包入口链接到项目发布页，具体发行版本与平台产物以实际发布内容为准。

## 官网同步

本目录是官网快速上手文档的唯一内容来源，官网入口为 <https://transportxlab.com/application/transportx-agent/guide/#start>。HTML、CSS、JavaScript 和 `assets/` 均在本目录维护，不直接修改网站仓库中的副本。

将修改提交并推送到本仓库 `main` 后，网站仓库 `transportx-public/website-resource` 的发布流程会在每次网站发布时拉取 `docs/guide/`，并每小时自动同步一次。也可以在网站仓库的 Actions 中手动运行 `web-deploy` 立即同步。GitHub 定时运行可能延迟。

本机尚未推送的修改，可使用网站仓库的 `scripts/sync_transportx_guide.py` 同步本目录后预览；命令见网站仓库 README。官网源文件与本目录保持一致，不添加仅存在于官网副本的内容。
