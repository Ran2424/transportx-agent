const imageSizes = {
  home: [1800, 1133], event: [1800, 1145], report: [1800, 1146],
  selection: [1800, 1033], transfer: [1800, 1148],
  'model-provider': [1020, 970], 'model-custom': [1020, 1320],
  'module-install': [1430, 390], 'new-task': [1020, 1340], attachment: [666, 249]
};
const figure = (name, alt, caption, size = '') => `<figure class="figure ${size}"><button type="button" class="image-open" aria-label="放大图片 ${alt}"><img src="assets/${name}.webp" width="${imageSizes[name][0]}" height="${imageSizes[name][1]}" alt="${alt}" loading="lazy" decoding="async"></button><figcaption>${caption} · 点击图片放大</figcaption></figure>`;
const note = (title, text, tip = false) => `<div class="note ${tip ? 'tip' : ''}"><strong class="note-title">${title}</strong><p>${text}</p></div>`;
const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const prompt = text => `<div class="prompt"><p>${text}</p><button type="button" class="copy-button">复制示例提问</button></div>`;

// Product descriptions follow the local 3.22.0 UI and module contracts.
const pages = [
  {
    id: 'overview', group: '开始', title: '什么是 TransportX', description: '认识交通分析工作台、功能与使用特点。',
    body: `<figure class="figure"><video class="product-video" controls playsinline preload="metadata" width="1920" height="1080" aria-label="TransportX 英文产品演示"><source src="assets/transportx-demo-en.mp4" type="video/mp4">你的浏览器不支持视频播放。<a href="assets/transportx-demo-en.mp4">打开英文演示视频</a></video><figcaption>68 秒英文演示：创建交通任务、提出问题、在地图中分析并交付报告。</figcaption></figure>
    ${note('一句话介绍', 'TransportX Agent 是一款面向交通分析的本地桌面工作台。你可以用自然语言提出问题，让 Agent 结合数据和分析工具，生成地图、图表、带引用的结论与报告。任务记录和成果文件保存在自己的电脑上。')}
    <h2 id="features">它能帮你做什么</h2>
    <ul class="feature-list">
      <li><strong>从交通问题开始分析</strong><p>分析路段、时段、客流与出行需求。上传表格或选择业务数据模块后，说明问题、范围和指标口径，Agent 可以检查数据、执行计算并整理结果。</p></li>
      <li><strong>在地图上继续提问</strong><p>查看 Agent 发布的空间图层，选择要素、标记点位、框选区域，或提交当前视野。下一轮分析可以沿用这份地图上下文。</p></li>
      <li><strong>生成图表与分析报告</strong><p>将统计结果整理为图件与 Markdown 报告，在工作台预览、核查和修改，并在桌面端导出 PDF。</p></li>
      <li><strong>核查结论的依据</strong><p>查看对话中的工具过程、源文件和已注册的引用证据。具备对应知识模块时，可以检索资料并定位来源。</p></li>
      <li><strong>查询与处理视频</strong><p>安装 Video Capability 和所需视频数据后，可以检索、播放、截图、裁剪、抽帧，并处理支持的时序指标。</p></li>
      <li><strong>按任务组合能力</strong><p>通过 Module 加入分析方法、工具、数据、知识库、模板或本地运行时。创建任务时选择需要的模块与版本。</p></li>
    </ul>
    <h2 id="characteristics">使用起来有什么特点</h2>
    <p><strong>提问、看图和检查文件在同一个工作台。</strong>对话用于推进分析，地图与文档画布用于查看成果，文件栏用于打开数据和输出文件。你可以围绕同一个任务继续补充条件、核查依据和修改报告。</p>
    <p><strong>地图既是结果，也能成为下一次提问的输入。</strong>不用反复用文字描述位置，选好范围并提交后，就可以问“这个区域内哪些站点的需求最高”。</p>
    <p><strong>每个任务有自己的记录与工作目录。</strong>任务保存使用的模块版本、相关文件与会话历史，恢复时校验对应能力和资产，便于继续分析与复核。</p>
    <h2 id="before-use">使用前需要知道</h2>
    <ul><li><strong>需要自行接入模型。</strong>应用提供 Agent 和分析运行环境，模型回复来自你配置的模型服务。首次使用需要准备 API Key。</li>
    <li><strong>业务数据需要另外准备。</strong>交通数据库、知识库和用户模块不随应用默认提供；演示中的上海数据来自示例环境。</li>
    <li><strong>本机保存不等于完全离线。</strong>使用远程模型时，提问和分析所需内容可能发送到所选服务商；地图底图等资源也可能需要联网。</li>
    <li><strong>模型费用由供应商决定。</strong>API 调用可能按用量收费。项目代码采用 AGPL-3.0-only；其他商业授权条件需与维护者协商，不能将开源许可等同于模型服务免费。</li>
    <li><strong>桌面发行目标是 macOS Apple Silicon 和 Windows x64。</strong>Linux 当前用于源码开发。</li></ul>
    <h2 id="begin">从这里开始</h2>
    <div class="start-links"><a href="#install"><span><strong>安装与首次启动</strong><small>选择与你的电脑匹配的安装包</small></span><span class="arrow">→</span></a><a href="#start"><span><strong>快速上手</strong><small>接入模型，创建任务，完成第一次数据分析</small></span><span class="arrow">→</span></a><a href="#faq"><span><strong>常见问题</strong><small>检查 API、模块、附件与成果导出问题</small></span><span class="arrow">→</span></a></div>`
  },
  {
    id: 'install', group: '开始', title: '安装与首次启动', description: 'macOS 和 Windows 的安装方式与准备事项。',
    body: `<p class="lead">安装桌面应用后，准备一个模型 API 和一份分析材料，就可以开始使用。</p>
    <h2 id="prepare">安装前准备</h2>${table(['准备项', '你需要知道'], [['系统与架构', 'macOS 12 或更高版本，Apple Silicon arm64；Windows 10 22H2 或 Windows 11，x64。Intel Mac 不属于当前桌面发行目标。'], ['安装包', '从项目发布渠道或维护者获取对应平台安装包。正式签名包与内部测试包的首次启动提示可能不同。'], ['模型服务', '准备 API Key；自定义接口还需提供 Model ID、API 类型和 Base URL。'], ['分析材料', '准备一份 Excel、CSV 或图片。需要专用能力时，另准备 Module 安装包。']])}
    <p><a href="https://github.com/Ran2424/transportx-agent/releases" target="_blank" rel="noreferrer">查看项目发布页 ↗</a>。以发布页实际提供的版本和安装包为准；没有对应平台产物时，请联系维护者。</p>
    <h2 id="mac">macOS 安装</h2><ol class="steps"><li>打开 arm64 的 <code>.dmg</code> 安装包。</li><li>将 <strong>TransportX Agent</strong> 拖入“应用程序”。</li><li>从“应用程序”打开应用，等待工作台加载。</li><li>如测试包被系统拦截，先确认来源和校验值，再按照该包附带的安装说明处理。不要套用其他版本的命令与应用路径。</li></ol>
    <h2 id="windows">Windows 安装</h2><ol class="steps"><li>运行 Windows x64 的 <code>setup.exe</code> 安装器。</li><li>按向导选择安装位置并完成安装。</li><li>启动 TransportX Agent，等待工作台加载。</li></ol>
    ${note('运行环境已随安装包提供', '普通桌面用户无需另装 Node.js、Pi CLI 或 Python。视频运行时通过 Video Capability 模块独立安装。', true)}
    <h2 id="first-launch">首次打开会看到什么</h2>${figure('home', 'TransportX 首页的新建交通任务入口', '首页的新建交通任务按钮与右上角设置入口')}
    <p>首页提供“新建交通任务”。首次使用时先通过右上角齿轮进入 <strong>设置 → Agent → 添加模型</strong>；也可以从新建任务窗口进入模型接入。</p>
    <p>界面语言、主题和本地目录可以在 <strong>设置 → 常规</strong> 查看。下一步请阅读 <a href="#start">快速上手</a>。</p>`
  },
  {
    id: 'start', group: '开始', title: '快速上手', description: '从配置 API 到第一次交通数据分析。',
    body: `<p class="lead">先跑通一个模型、一份数据和一次分析。地图、知识库和视频能力可以随后按需加入。</p>
    ${note('开始前', '确认已安装桌面应用，并准备 API Key 和一份小型 Excel 或 CSV。还没安装？先查看 <a href="#install">安装与首次启动</a>。')}
    <h2 id="connect">第一步 接入模型服务</h2><p>打开 <strong>设置 → Agent → 添加模型</strong>。供应商出现在列表中时，可使用“Pi 供应商”模式：</p>
    <ol class="steps"><li>在服务商平台创建并复制 API Key。</li><li>选择与密钥对应的供应商，粘贴 API Key。</li><li>点击“接入供应商”；返回设置，确认模型列表已加载。</li></ol>
    ${figure('model-provider', '选择供应商并填写 API Key 的真实表单', '供应商模式：选供应商、填密钥，再接入', 'compact')}
    <p>需要填写自定义接口地址时，选择“自定义服务”，按 <a href="#models">模型 API 接入</a> 的字段说明配置。</p>
    ${note('怎样验证接入成功', '创建任务后发一句简短提问，确认收到回复。顶部“已连接”表示工作台连接本地服务，不代表远程模型 API 已验证。', true)}
    <h2 id="module">第二步 准备所需模块</h2><p>模块把常用功能、分析方法和资料打包保存，供不同任务重复使用。例如，一套交通数据库可以连同字段说明、统计方法和报告模板一起封装，下次分析时直接选用。</p>
    <p>你可以直接与 Agent 对话，把自己的数据、资料或常用流程交给它，说明后续用途，让它帮忙<a href="#modules/author">制作模块</a>。只用一次的文件，作为任务附件添加即可。</p>
    <p>已有模块包时，打开 <strong>设置 → 模块</strong>，选择或拖入 ZIP，确认名称、版本与安装项后安装。</p>
    ${figure('module-install', '模块 ZIP 压缩包选择和拖入入口', '模块在设置页安装，普通数据文件在任务中添加')}
    <p>安装后启用模块，在下一步创建任务时勾选。详细说明见 <a href="#modules">模块与能力</a>。</p>
    <h2 id="create">第三步 创建交通任务</h2><ol class="steps"><li>回到首页，点击“新建交通任务”。</li><li>填写任务名称，例如“路口一周交通量分析”。</li><li>选择本次需要的模块与版本，取消无关业务模块。</li><li>按需补充城市、项目、空间范围与起止时间，选择刚接入的模型。</li><li>点击“创建任务”，进入对话区。应用会自动创建任务工作目录。</li></ol>
    ${figure('new-task', '新建任务中的名称、模块版本和模型选择', '截图中的业务模块来自示例环境，需要另行安装', 'narrow')}
    <h2 id="attach">第四步 添加数据并提问</h2><p>点击输入区左下角“＋”添加 Excel 或 CSV，或将文件拖入输入框。等待上传完成后，再输入问题。</p>
    ${figure('attachment', '输入区左下角添加附件与右下角发送按钮', '单个附件上限为 50 MiB', 'compact')}
    ${prompt('请分析我上传的交通量表。先检查字段、时间范围、缺失值和交通量单位；遇到不明确的口径先问我。确认后，统计每日交通量和高峰时段，绘制趋势图，并生成一份 Markdown 简报，写明数据来源、计算方法和主要结论。')}
    <p><kbd>Enter</kbd> 发送，<kbd>Shift + Enter</kbd> 换行。Agent 提问时补充必要信息；要修改结果，继续在同一任务中说明要求。</p>
    <h2 id="result">第五步 核查并导出成果</h2><ol class="steps"><li>打开文件栏或回复中的文件链接，查看生成的图表和报告。</li><li>核对单位、时间范围、计算口径与数据来源。有引用时点击标记查看证据。</li><li>在文档画布中下载原文件，或点击“生成并下载 PDF”。</li></ol>
    ${note('第一次使用的完成标志', '模型能回复，材料已读入，分析口径已核对，成果文件能打开。接下来可以继续 <a href="#map">地图分析</a> 或了解 <a href="#reports">报告与引用</a>。', true)}`
  },
  {
    id: 'workbench', group: '开始', title: '认识工作台', description: '了解侧栏、对话、文件与画布分别用来做什么。',
    body: `<p class="lead">TransportX 把分析对话、能力、任务文件与成果画布放在一个窗口中。不同区域围绕当前任务工作。</p>
    ${figure('event', '交通地图、能力侧栏、会话与对话组成的工作台', '带地图的任务工作台，区域可按需要展开或收起')}
    <h2 id="areas">主要区域分别做什么</h2>${table(['区域', '用途'], [['顶部工具栏', '选择当前模型与思考级别；打开命令面板、文件栏、画布和设置。'], ['能力与会话侧栏', '浏览技能、数据和知识能力；搜索、创建和打开任务。能力信息反映服务端投影，不只是文件目录。'], ['对话区', '提出问题，查看回复与工具过程，补充条件，添加附件和引用。'], ['文件栏', '浏览当前任务工作目录中的文件，预览数据和成果。'], ['成果画布', '查看地图、视频、文档等成果视图，并将需要的上下文附加到后续提问。']])}
    <h2 id="views">根据任务切换视图</h2><p>第一次分析时可以先专注对话和文件；需要看地图或报告时再展开画布。画布打开后，分隔条可以调整对话与成果区域的宽度。</p>
    ${figure('report', '文档画布与对话区并排展示的月报视图', '报告视图中，对话区仍用于核查与修改结果')}
    <h2 id="shortcuts">常用操作</h2><ul><li><strong>新建任务：</strong>首页或会话侧栏的新建入口。</li><li><strong>打开设置：</strong>顶部右侧齿轮。</li><li><strong>命令面板：</strong><kbd>Cmd / Ctrl + K</kbd>。</li><li><strong>发送与换行：</strong><kbd>Enter</kbd> 发送，<kbd>Shift + Enter</kbd> 换行。</li></ul>
    ${note('当前任务决定资源范围', '切换任务后，文件与成果视图也会对应新的任务。找不到文件时，先确认你打开的是哪个任务。', true)}`
  },
  {
    id: 'conversation', group: '日常使用', title: '提问与任务管理', description: '提出清楚的问题，继续分析并复核历史结果。',
    body: `<p class="lead">一个任务可以持续多轮。先明确分析问题，再补充条件、查看结果和修改成果。</p>
    <h2 id="question">怎样提出一个可执行的问题</h2><p>说明<strong>分析对象、时间范围、指标口径和交付形式</strong>。有数据时明确使用哪些附件或模块；没有足够数据时，要求 Agent 先说明缺什么。</p>
    ${prompt('请分析附件中 A 路口的工作日早高峰交通量。先确认数据的日期范围和单位，再按小时汇总，比较每天 7:00 到 9:00 的变化，输出一张对比图和一页结论。缺少必要字段时先告诉我，不要补造数据。')}
    <h2 id="followup">在同一任务中继续</h2><ul><li>Agent 询问范围、口径或必要信息时，补充后再继续。</li><li>看到初步结果后，可以问“只保留工作日”“改用每小时均值”或“解释异常点的依据”。</li><li>运行中可补充指令；不需要继续时点击停止。</li><li>查看工具卡片和生成文件，核对 Agent 实际用了什么数据与方法。</li></ul>
    <h2 id="history">打开历史任务</h2><p>在会话侧栏搜索并打开原任务，沿用文件与记录继续提问。原任务使用的模块版本和资产需要保持可用；安装新模块不会自动替换旧任务的能力组合。</p>
    <h2 id="scope">任务范围与事实边界</h2><p>创建窗口中的城市、项目、空间和时间范围是分析背景，不会自动生成相应数据。回答的完整程度取决于可用材料、模块与模型。</p>
    ${note('核查后再交付', '模型可以协助处理数据与组织报告，但统计口径、单位、异常值和证据仍需要核对。要求 Agent 区分原始数据、计算结果和推断。', true)}`
  },
  {
    id: 'map', group: '日常使用', title: '地图与空间分析', description: '查看地图结果，并把选区作为后续问题的输入。',
    body: `<p class="lead">你与 Agent 使用同一份地图上下文。地图图层可以展示结果，选中的位置和范围也可以附到下一轮提问。</p>
    ${figure('selection', '轨道交通地图中的矩形选区与需求图层', '框选分析区域后，提交范围并继续提问')}
    <h2 id="show">让结果显示在地图上</h2><p>提供带空间信息的数据或选用对应模块后，可以要求“把这些站点展示到地图，并按需求量着色”。Agent 发布图层后，打开地图画布查看。</p>
    <p>支持的空间工具包括缓冲区、最近邻和空间连接等。具体分析还需要相应字段、坐标参考信息与可用数据。</p>
    <h2 id="select">把地图范围交给 Agent</h2><ol class="steps"><li>在地图工具栏选择要素、点位、矩形或当前视野模式。</li><li>完成选择，查看待提交范围。</li><li>使用地图中的附加操作，将地理上下文附到输入区；若正在回应 Agent 的选区请求，按界面提示提交。</li><li>发送问题，例如“比较这个区域内的站点需求，列出最高的五个站点”。</li></ol>
    ${note('移动地图不会自动提交上下文', '缩放、平移或仅停留在某个区域，不会自动把位置发给 Agent。完成附加或提交后，再发送问题。地图更新后，旧选区可能需要重新选择。', true)}
    <h2 id="layers">核查地图与导出图件</h2><p>检查图层来源、坐标系、单位和图例；按需要切换图层可见性或定位到数据。地图工具栏可保存截图，再结合报告使用。</p>
    ${figure('transfer', '轨道线路和接驳需求站点的地图与排名', '地图与排名表可以共同核查空间分布，示例数据需要另行提供')}`
  },
  {
    id: 'reports', group: '日常使用', title: '报告与引用', description: '找到输出文件，核查证据并交付报告。',
    body: `<p class="lead">让 Agent 把分析组织成文件，保留图件、引用和计算说明，再从工作台预览与下载。</p>
    ${figure('report', '带图表、目录和引用的报告阅读视图', 'Markdown 报告在文档画布中预览，可下载原文件或 PDF')}
    <h2 id="generate">生成需要的报告</h2>${prompt('请将本任务已经核实的分析结果整理为 Markdown 报告。包含问题与范围、数据来源、计算口径、主要图表、结论和局限。将报告和图件保存到当前任务工作区，告诉我文件位置，不补充没有依据的数字。')}
    <h2 id="verify">查看文件与引用</h2><ol class="steps"><li>从文件栏或回复中的文件链接打开报告。</li><li>核对图表、单位、时间范围和方法说明。</li><li>有已注册引用时，点击标记查看来源证据。知识检索能力由对应知识模块提供。</li><li>需要调整内容或样式时，在同一任务中提出具体要求。</li></ol>
    <p>源文件被修改后，引用可能提示内容已变化或失效。重新核对最新材料，不要把旧引用当作当前证据。</p>
    <h2 id="export">下载与交付</h2><p>在文档画布点击<strong>“下载原文件”</strong>保存 Markdown；桌面端可以点击<strong>“生成并下载 PDF”</strong>导出阅读版本。其他成果文件可从文件区打开或获取。</p>
    ${note('报告取决于本次实际分析', '示例月报展示的是一种成果形式。你的图表、章节与数字由所提供的数据、任务要求和执行结果决定。', true)}`
  },
  {
    id: 'models', group: '能力与数据', title: '模型 API 接入', description: '供应商与自定义服务的配置字段和验证方法。',
    body: `<p class="lead">模型负责理解问题与推进分析。先接入一个可用服务，再创建任务。模型配置入口在“设置 → Agent → 添加模型”。</p>
    <h2 id="provider">使用 Pi 供应商</h2><p>供应商在列表中时，选择它并填写对应 API Key，然后点击“接入供应商”。接入后可使用该供应商目录中的模型；列表随当前运行时和配置变化。</p>
    ${figure('model-provider', '模型供应商选择与密钥填写窗口', '已有本机凭据时，提交会更新对应供应商凭据', 'compact')}
    <h2 id="custom">使用自定义服务</h2><p>需要指定接口地址或模型时，选择“自定义服务”。按服务商提供的接入说明填写，不要直接照抄截图中的占位提示。</p>
    ${figure('model-custom', '自定义服务的 Provider ID Model ID API 类型和基础地址', '模型名称与 API 地址的示例占位符不代表可用配置', 'narrow')}
    ${table(['字段', '填写方式'], [['Provider ID', '该供应商的标识。同一供应商下的模型可按界面提示复用已有凭据。'], ['Model ID', '服务商要求的准确模型标识，不能用显示名称代替。'], ['Pi API 类型', '选择服务实际使用的协议：OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Google Generative AI。'], ['API Base URL', '填写服务商给出的 API 基础地址，不是浏览器中的聊天网页地址。'], ['API Key', '与该模型和接口对应的密钥。已有凭据时可按界面提示留空。'], ['其他字段', '显示名称可选；上下文窗口、推理和图像输入能力按服务实际支持情况填写。']])}
    <h2 id="check">保存后怎样验证</h2><ol class="steps"><li>返回设置页确认模型列表可见。</li><li>创建新任务，选择刚接入的模型。</li><li>发出简短提问，确认收到正常回复，再上传分析材料。</li></ol>
    <p>接入变更用于新任务；已有运行任务需重新启动后载入。认证失败时检查密钥和额度，接口错误时核对 Model ID、API 类型与 Base URL。</p>
    <h2 id="credential">凭据与费用</h2><p>API Key 保存在本机，工作台不会返回已有密钥原文。不要在截图、报告或问题反馈中公开密钥。使用远程服务时，请了解服务商对材料内容的处理规则与计费方式。</p>`
  },
  {
    id: 'modules', group: '能力与数据', title: '模块与能力', description: '安装工具、方法、数据、知识与视频运行时。',
    body: `<p class="lead">模块把常用功能、分析方法和资料打包保存。安装后，在创建任务时选择需要的模块，就能沿用其中的工具、数据和使用说明。</p>
    <h2 id="contents">一个模块可以带来什么</h2>${table(['贡献内容', '作用'], [['Skill', '告诉 Agent 怎样使用方法、数据与工具。'], ['Extension', '注册工具或界面交互能力。'], ['Data / Knowledge', '提供数据库、资料与检索所需资产。'], ['Template', '提供报告等成果的模板资产。'], ['Native Runtime', '携带本地运行工具，如视频模块的 ffmpeg / ffprobe。']])}
    <h2 id="author">让 Agent 制作模块</h2><p>在任务中添加数据或资料，说明哪些内容需要保留、以后怎样使用。Agent 可以整理文件、补充字段与来源说明，将分析方法和报告模板一起封装为模块。</p>
    ${prompt('请把这份交通量数据封装为可安装的模块，供以后的任务使用。保留原始数据，补充字段、单位和来源说明，并加入按日统计与高峰时段分析的方法。完成后检查模块包，告诉我怎样安装。')}
    <p>确认内容后，通过“设置 → 模块”安装生成的模块包，再创建任务使用。若 Agent 提示缺少模块制作能力，先检查当前任务是否提供 Module Authoring。</p>
    <h2 id="install">从 ZIP 安装</h2>${figure('module-install', '设置中模块 ZIP 安装区域', '点击或拖入 ZIP 后，先识别再确认安装')}
    <ol class="steps"><li>获取可信来源、兼容当前应用版本的模块包。</li><li>在“设置 → 模块”选择或拖入 ZIP。</li><li>确认识别出的名称、版本与状态，勾选可安装项并安装。</li><li>在已接入模块列表检查结果，按需启用。</li><li>创建新任务并选择所需模块和版本。</li></ol>
    <p>含运行时的模块必须匹配系统和架构。已经解压的完整模块目录，也可通过“模块包路径”安装；目录需要包含 <code>manifest.json</code>。</p>
    <h2 id="states">已安装不等于当前任务可用</h2>${table(['状态', '含义'], [['已安装', '模块包已进入本机受管目录。'], ['已启用', '允许新任务使用该模块。'], ['被本任务选择', '任务创建时选择了该模块及版本。'], ['工具与资产可用', '依赖、数据资产和运行时满足本任务要求。']])}
    ${note('任务保留创建时的能力版本', '模块启停影响新任务。已有任务不会自动切换到刚安装的版本；活动任务正在使用的模块不能直接卸载。', true)}
    <h2 id="video">视频能力需要单独安装</h2><p>Video Capability 携带视频处理工具与运行时，需选择对应平台的安装包。要检索具体摄像头或录像，还需要可用的视频数据。安装视频工具并不会自动获得录像资源。</p>
    <h2 id="missing">提示资产缺失时</h2><p>按该模块交付说明核对资产目录、索引与完整性。设置页没有通用的任意数据库绑定向导；不要把普通 CSV 拖到模块安装区来补齐缺失资产。</p>`
  },
  {
    id: 'data', group: '能力与数据', title: '数据导入与本地文件', description: '区分任务附件和模块资产，找到本机任务文件。',
    body: `<p class="lead">本次分析的文件可直接添加为附件。反复使用的数据和资料，可以让 Agent <a href="#modules/author">封装为模块</a>，供后续任务选用。</p>
    <h2 id="choose">选择合适的入口</h2>${table(['你手里的材料', '使用入口'], [['Excel、CSV、图片或文档', '创建任务后，在对话输入区添加附件。'], ['模块 ZIP', '设置 → 模块，识别并确认安装。'], ['包含 manifest.json 的模块目录', '设置 → 模块 → 模块包路径。'], ['模块要求的数据库、知识原文或索引', '按该模块的资产交付说明配置，不是普通附件上传。']])}
    <h2 id="attachment">给任务添加附件</h2>${figure('attachment', '对话输入区的添加附件按钮', '通过“＋”、拖入文件或粘贴图片添加材料', 'compact')}
    <ol class="steps"><li>打开目标任务，点击输入框左下角“＋”选择文件，或把文件拖入输入框。</li><li>等待附件卡片显示上传完成，确认没有错误。</li><li>发送问题，说明使用哪个附件和需要分析的内容。</li></ol>
    <p>单个附件上限为 <strong>50 MiB</strong>。图片可从剪贴板粘贴。上传成功并不保证格式、内容或分析口径正确，请先让 Agent 检查文件。</p>
    <h2 id="quality">分析前说明数据口径</h2><p>表格最好有明确表头，并说明时间字段、地理对象、指标单位、缺失值含义和统计范围。空间数据还应提供坐标系。资料类文件应保留来源与版本信息。</p>
    ${prompt('先检查附件的表头、行数、时间范围、单位和缺失值，告诉我可以支持哪些分析。请区分原始数据与推断；遇到不清楚的字段先问我。')}
    <h2 id="local">找到本机文件</h2><p>在任务文件栏浏览当前工作区；点击目录入口可在文件管理器中打开。应用数据、任务工作区、模型配置与模块路径可在 <strong>设置 → 常规 → 本地目录</strong> 查看。</p>
    <p>macOS 默认数据根目录为 <code>~/.transportx/traffic-agent/</code>。其他平台以设置页显示为准。备份时需保留任务记录、成果和所依赖的模块资产；凭据文件单独保管。</p>
    ${note('数据在本机，模型调用仍可能需要外部服务', '任务和文件默认保存到本机。远程模型在分析过程中可能接收所需材料内容，请按数据使用要求选择服务。', true)}`
  },
  {
    id: 'faq', group: '帮助', title: '常见问题', description: '排查安装、API、模块、附件和成果问题。',
    body: `<p class="lead">先确定卡在哪一步：应用启动、模型回复、材料准备，还是成果查看。</p>
    <h2 id="setup">安装与模型</h2>
    <details class="faq-item" open><summary>需要先安装 Python 或 Node.js 吗？</summary><p>桌面安装包已提供 Agent 与 Python 运行环境，普通用户无需另装。源码开发的安装流程不同，不属于本指南的首次使用路径。</p></details>
    <details class="faq-item"><summary>顶部已连接，为什么模型没有回复？</summary><p>“已连接”表示工作台连接本地服务。检查所选模型、API Key、服务额度、网络和接口配置，用一句简短提问验证实际模型调用。</p></details>
    <details class="faq-item"><summary>模型列表有模型，为什么仍然调用失败？</summary><p>出现模型列表不等于 API 已验证。认证错误检查密钥与服务权限；模型不存在检查 Model ID；协议或地址错误检查 API 类型和 Base URL。自定义能力勾选应与服务实际能力一致。</p></details>
    <details class="faq-item"><summary>创建任务按钮不可用怎么办？</summary><p>先选择模型，再检查所选模块有没有缺失资产。取消无关模块；需要的业务模块则按其交付说明补齐数据或依赖。</p></details>
    <h2 id="resources">模块与数据</h2>
    <details class="faq-item"><summary>安装新模块后，旧任务为什么没有新能力？</summary><p>任务保留创建时选择的模块版本。安装并启用模块后，创建新任务并勾选；不要假设旧任务会自动更新能力。</p></details>
    <details class="faq-item"><summary>应用自带截图中的交通数据库吗？</summary><p>不自带。产品截图来自示例环境。交通数据、知识库与用户模块需要另外提供，安装应用不会自动获得对应业务材料。</p></details>
    <details class="faq-item"><summary>附件为什么上传失败？</summary><p>单个文件上限为 50 MiB。检查大小与上传错误；若附件仍在上传，等待完成后再发送。大型数据按任务工作区或模块的实际交付方式处理。</p></details>
    <details class="faq-item"><summary>模块提示资产缺失，把文件上传为附件可以解决吗？</summary><p>通常不能。模块资产与任务附件是不同入口，应按该模块的说明配置所需数据库、资料或索引。</p></details>
    <h2 id="outputs">成果与隐私</h2>
    <details class="faq-item"><summary>看不到地图、报告或文件怎么办？</summary><p>确认选择了正确任务，并打开顶部文件栏或画布按钮。Agent 必须先生成文件或发布地图资源，对应内容才会出现。</p></details>
    <details class="faq-item"><summary>报告无法导出 PDF 怎么办？</summary><p>先检查 Markdown 报告和图片是否正常预览，再重试“生成并下载 PDF”。仍失败时可先下载原文件，并保留错误信息排查。</p></details>
    <details class="faq-item"><summary>本地应用可以完全离线使用吗？</summary><p>取决于所用模型和资源。远程 API、在线底图或其他外部服务需要联网；本机保存记录不代表所有分析都不访问网络。</p></details>
    <h2 id="feedback">反馈问题时提供什么</h2><p>说明应用版本、操作系统、操作步骤和错误提示。截图中隐藏 API Key 与敏感材料；不要上传 auth.json。可通过 <a href="https://github.com/Ran2424/transportx-agent/issues" target="_blank" rel="noreferrer">项目 Issues ↗</a> 反馈可复现的问题。</p>`
  }
];

const article = document.querySelector('#article');
const navigation = document.querySelector('#navigation');
const toc = document.querySelector('#toc');
const sidebar = document.querySelector('#sidebar');
const menu = document.querySelector('#menu-toggle');
const searchDialog = document.querySelector('#search-dialog');
const searchInput = document.querySelector('#search-input');
let activePage;
let sectionObserver;

for (const group of [...new Set(pages.map(page => page.group))]) {
  navigation.insertAdjacentHTML('beforeend', `<section class="nav-group"><h2>${group}</h2>${pages.filter(page => page.group === group).map(page => `<a href="#${page.id}" data-page="${page.id}">${page.title}</a>`).join('')}</section>`);
}

function setMenu(open) {
  sidebar.classList.toggle('is-open', open);
  document.body.classList.toggle('nav-open', open);
  menu.setAttribute('aria-expanded', String(open));
  document.querySelector('#sidebar-scrim').hidden = !open;
}

function render() {
  const [id, sectionId] = location.hash.slice(1).split('/');
  const page = pages.find(item => item.id === id) || pages[0];
  const changed = activePage !== page.id;
  if (changed) {
    activePage = page.id;
    document.title = `${page.title} · TransportX 文档`;
    article.innerHTML = `<div class="breadcrumb">使用文档 / ${page.group}</div><h1>${page.title}</h1>${page.body}`;
    article.querySelector('.figure img')?.setAttribute('loading', 'eager');
    navigation.querySelectorAll('a').forEach(link => {
      if (link.dataset.page === page.id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const headings = [...article.querySelectorAll('h2')];
    toc.innerHTML = headings.map(h => `<a href="#${page.id}/${h.id}">${h.textContent}</a>`).join('');
    sectionObserver?.disconnect();
    sectionObserver = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) toc.querySelectorAll('a').forEach(link => link.classList.toggle('is-active', link.hash.endsWith(`/${visible[0].target.id}`)));
    }, { rootMargin: '-90px 0px -55% 0px' });
    headings.forEach(h => sectionObserver.observe(h));
    const index = pages.indexOf(page);
    const previous = pages[index - 1];
    const next = pages[index + 1];
    document.querySelector('#pager').innerHTML = `${previous ? `<a class="previous" href="#${previous.id}"><span>上一篇</span><strong>← ${previous.title}</strong></a>` : ''}${next ? `<a class="next" href="#${next.id}"><span>下一篇</span><strong>${next.title} →</strong></a>` : ''}`;
  }
  setMenu(false);
  if (sectionId) requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView());
  else if (changed) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (id) article.focus({ preventScroll: true });
  }
}

const searchIndex = pages.map(page => {
  const content = document.createElement('div');
  content.innerHTML = page.body;
  return { ...page, text: content.textContent.replace(/\s+/g, ' ') };
});
function search() {
  const terms = searchInput.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = searchIndex.filter(page => terms.every(term => `${page.title} ${page.description} ${page.text}`.toLocaleLowerCase().includes(term)));
  const container = document.querySelector('#search-results');
  container.replaceChildren();
  for (const page of results) {
    const link = document.createElement('a');
    link.href = `#${page.id}`;
    const title = document.createElement('strong'); title.textContent = page.title;
    const description = document.createElement('p'); description.textContent = page.description;
    link.append(title, description); container.append(link);
  }
  if (!results.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '没有找到相关内容，试试“API”“模块”或“数据”。'; container.append(empty);
  }
}
function openSearch() {
  if (!searchDialog.open) searchDialog.showModal();
  search(); searchInput.focus();
}
document.querySelector('#search-open').addEventListener('click', openSearch);
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault(); article.focus(); article.scrollIntoView();
});
searchInput.addEventListener('input', search);
document.querySelector('#search-results').addEventListener('click', event => {
  if (event.target.closest('a')) searchDialog.close();
});
menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
document.querySelector('#sidebar-scrim').addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape') setMenu(false);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
}));
article.addEventListener('click', async event => {
  const imageButton = event.target.closest('.image-open');
  if (imageButton) {
    const image = imageButton.querySelector('img');
    const preview = document.querySelector('#image-preview'); preview.src = image.src; preview.alt = image.alt;
    document.querySelector('#image-caption').textContent = image.alt;
    document.querySelector('#image-dialog').showModal();
  }
  const copyButton = event.target.closest('.copy-button');
  if (copyButton) {
    const text = copyButton.parentElement.querySelector('p').textContent;
    try {
      await navigator.clipboard.writeText(text); copyButton.textContent = '已复制'; document.querySelector('#status').textContent = '示例提问已复制';
    } catch {
      const range = document.createRange(); range.selectNodeContents(copyButton.parentElement.querySelector('p'));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); copyButton.textContent = '已选中，请复制';
    }
  }
});
window.addEventListener('hashchange', render);
render();
