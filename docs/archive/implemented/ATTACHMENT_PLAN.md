# ATTACHMENT_PLAN.md

> **V1 状态：已完成（2026-08-10）**
>
> Phase 1–3 已落地并通过附件相关验证：附件上传持久化、统一前端入口、消息引用、Agent 上下文、视觉输入、历史恢复和附件预览均已接通。Phase 4 的深度文件解析适配器属于后续能力，不作为本次 V1 的完成条件。

## 1. 背景

当前附件能力本质上是“图片临时输入”：

- 文件选择器只接受 PNG / JPEG / GIF / WebP。
- 拖拽虽然能够拿到任意 `File`，但后续 `processImage()` 会拒绝非图片。
- 剪贴板主要处理图片内容。
- 图片由浏览器通过 `FileReader` 读取，并经 Canvas 缩放后转成 Base64。
- Base64 图片保存在 React 内存状态中。
- 发送时通过 WebSocket 放入 Pi 的 `prompt.images`。
- 原始文件不会写入当前 Session 的工作目录。
- 历史消息、刷新恢复、Agent 后续再次读取文件等链路不完整。

当前实现集中在：

- `src/web/platform/conversation/ConversationWorkspace.tsx`
- `src/public/app-types.ts`

现有文件类型展示和工作区文件浏览能力可优先复用：

- `src/web/platform/workspace/FilePreview.tsx`
- `src/web/platform/workspace/WorkspaceDock.tsx`

本次不要继续扩展现有 `processImage()`，而应将其重构为 **Session 级统一附件系统**。

---

## 2. 改造目标

将当前：

```text
图片
→ 浏览器读取
→ Base64
→ WebSocket
→ prompt.images
→ Pi
```

升级为：

```text
任意附件
→ 独立上传接口
→ 持久化到当前 Session
→ 生成 SessionAttachment
→ 消息仅引用 attachment IDs
→ 服务端解析真实附件
→ 向 Agent 注入附件上下文
→ Agent 按需读取
```

对于图片，在完成普通附件持久化之外，若当前模型支持视觉输入，再额外转换为 Pi 支持的 image 内容。

本次改造最终必须满足四个核心目标：

1. **上传持久化**：附件真实存在于当前 Session 工作目录。
2. **消息引用**：消息只保存附件 ID，不保存文件本体。
3. **Agent 可寻址**：Agent 能获知附件名称、类型和安全相对路径。
4. **历史可恢复**：刷新或恢复历史会话后，消息附件仍然可展示和读取。

---

## 3. 非目标

V1 不要扩展成完整文档平台。

以下能力不作为首版附件系统上线前置条件：

- 上传时自动解析所有文件。
- OCR。
- PDF 页面渲染。
- Office 在线预览。
- 全文索引。
- 自动 RAG。
- ZIP 自动解压。
- 文件版本管理。
- 跨 Session 附件共享。
- 云对象存储。
- 上传后自动总结。
- 对未知二进制文件内容作理解保证。

需要严格区分：

> “任意文件可上传” 与 “任意文件可理解” 是两个不同能力。

---

## 4. 核心设计原则

### 4.1 Session 是附件的归属边界

所有附件必须属于某个 Session。

推荐目录结构：

```text
<session.cwd>/
  attachments/
    att_a1b2c3/
      交通组织方案.pdf
    att_d4e5f6/
      clipboard-20260810-153012-1.png
  .tau/
    attachments.json
```

采用：

```text
附件 ID 子目录 + 原始文件名
```

而不是直接：

```text
attachments/<original-file-name>
```

目的：

- 避免同名覆盖。
- 保留用户可识别文件名。
- 允许同一个 Session 中存在多个同名文件。
- 便于后续为附件保存派生文件。

---

### 4.2 服务端是附件元数据和路径的唯一可信来源

前端不能自行决定或提交真实绝对路径。

前端上传文件后，只接收服务端返回的附件元数据。

发送消息时，只允许提交：

```ts
attachmentIds: string[]
```

服务端收到 attachment ID 后必须验证：

1. attachment 是否存在。
2. attachment 是否属于当前 Session。
3. attachment 状态是否为 `ready`。
4. 实际路径是否仍然位于当前 `session.cwd` 内。
5. 文件是否仍然存在。
6. 不能通过软链接、`../` 等方式逃逸 Session。

---

### 4.3 上传与消息发送解耦

禁止继续通过 WebSocket 发送 Base64 文件内容。

目标链路：

```text
HTTP / Upload
    ↓
Session Attachment Storage
    ↓
SessionAttachment metadata
    ↓
attachmentId

WebSocket / Prompt
    ↓
attachmentIds[]
```

WebSocket 应只承担轻量消息协议，不承担大文件传输。

---

### 4.4 消息引用附件，不拥有附件

附件属于 Session，消息只是引用。

推荐模型：

```text
Session
 ├── Attachment A
 ├── Attachment B
 └── Messages
      ├── Message 1 → [Attachment A]
      └── Message 2 → [Attachment A, Attachment B]
```

消息结构建议扩展为：

```ts
type ConversationMessage = {
  // existing fields...
  attachmentIds?: string[];
};
```

不要把文件本体、Base64 或绝对路径保存到消息对象。

---

### 4.5 图片同时走“文件”和“视觉输入”两条链路

图片附件必须首先作为普通附件落盘。

如果当前模型支持视觉输入，再额外转换为 Pi image 内容。

```text
Image Attachment
  ├── 保留原始文件 → Agent 可通过路径读取
  └── 转为 image content → 视觉模型
```

不能因为图片已经进入 `prompt.images` 就不保存原始文件。

---

## 5. 共享附件协议

建议新增共享协议：

```ts
type SessionAttachmentKind =
  | 'image'
  | 'pdf'
  | 'document'
  | 'table'
  | 'archive'
  | 'other';

type SessionAttachmentSource =
  | 'picker'
  | 'drop'
  | 'clipboard';

type SessionAttachmentStatus =
  | 'uploading'
  | 'ready'
  | 'error';

type SessionAttachment = {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  kind: SessionAttachmentKind;
  source: SessionAttachmentSource;
  status: SessionAttachmentStatus;
};
```

必要时可增加但不要过度设计：

```ts
createdAt?: string;
error?: string;
```

如果 `uploading` 只存在于前端，也可以将“持久化附件状态”和“前端上传状态”拆开。

核心字段必须保持稳定：

```text
id
name
relativePath
mimeType
size
sha256
kind
source
status
```

---

## 6. 上传入口

所有前端入口必须最终收敛到同一函数，例如：

```ts
addAttachments(files: File[], source: AttachmentSource)
```

需要支持三类入口。

### 6.1 文件选择器

支持：

- 单文件。
- 多文件。
- 图片。
- PDF。
- Word。
- Excel / CSV。
- 文本。
- 压缩包。
- 未知后缀普通文件。

不要再用 `accept=image/*` 作为能力边界。

如果产品仍希望文件选择器提供类型提示，可以配置宽松 `accept`，但服务端不能依赖前端 `accept` 做安全控制。

---

### 6.2 拖拽

支持一次拖入一个或多个文件。

拖拽入口必须直接进入统一附件收集逻辑，不得再经过 `processImage()`。

---

### 6.3 剪贴板

需要同时处理：

- 从 Finder / 文件资源管理器复制的一个或多个文件。
- 系统截图。
- 图片编辑器复制出的无文件名图片。
- 多个 clipboard file item。

对于没有有效文件名的图片，自动生成：

```text
clipboard-YYYYMMDD-HHmmss-N.png
```

例如：

```text
clipboard-20260810-153012-1.png
```

同一次 paste 事件内的 `N` 递增。

需要做基本去重，避免同一个 Clipboard Item 同时以多个入口被重复添加。

---

## 7. 服务端上传能力

新增独立的 Session 附件上传接口。

具体路由名称可按现有 Agent Host API 风格决定，例如：

```text
POST /api/sessions/:sessionId/attachments
```

支持 multipart/form-data 和流式处理。

不要：

- 先完整读入内存。
- 将整个文件转成 Base64。
- 通过 WebSocket 上传。

推荐流程：

```text
接收 multipart 文件流
→ 创建临时文件
→ 边写入边统计 size / sha256
→ 校验
→ 创建 attachment id
→ 创建 attachments/<id>/
→ 原子移动到最终路径
→ 更新附件索引
→ 返回 SessionAttachment
```

---

## 8. 文件安全要求

附件接口属于文件系统边界，必须明确处理以下问题。

### 8.1 文件名

保留用户可识别的原始名称，但必须清理危险路径字符。

例如输入：

```text
../../secret.txt
```

不能产生路径逃逸。

最终只允许使用 basename / sanitized basename。

---

### 8.2 路径逃逸

所有最终路径都必须验证位于：

```text
<session.cwd>/attachments/
```

之下。

禁止：

- `../`
- 绝对路径注入。
- Windows drive path 注入。
- 软链接逃逸。
- attachment ID 中注入路径分隔符。

---

### 8.3 同名文件

同名文件不得覆盖。

使用 attachment ID 子目录天然解决：

```text
attachments/att_001/report.pdf
attachments/att_002/report.pdf
```

---

### 8.4 原子写入

上传时先写临时文件。

只有：

- 上传完整。
- 校验通过。
- SHA-256 完成。

之后才能移动到最终位置并标记为 `ready`。

不能让 Agent 读取半写入文件。

---

### 8.5 单文件失败隔离

多文件上传时：

> 一个附件失败不能导致同批其他附件全部丢失。

前端和接口都应以附件粒度反馈结果。

---

## 9. 附件索引

附件元数据需要持久化。

首版可使用：

```text
<session.cwd>/.tau/attachments.json
```

示例：

```json
{
  "version": 1,
  "attachments": [
    {
      "id": "att_a1b2c3",
      "name": "交通组织方案.pdf",
      "relativePath": "attachments/att_a1b2c3/交通组织方案.pdf",
      "mimeType": "application/pdf",
      "size": 2516582,
      "sha256": "...",
      "kind": "pdf",
      "source": "picker",
      "status": "ready"
    }
  ]
}
```

要求：

- 写入操作尽量原子化。
- Session 恢复时能够重新读取。
- 不要完全依赖浏览器状态。
- 不要将绝对路径写入索引。

---

## 10. 删除逻辑

首版至少支持删除“尚未发送”的附件。

推荐接口：

```text
DELETE /api/sessions/:sessionId/attachments/:attachmentId
```

删除前服务端重新校验 Session 归属。

如果附件已经被历史消息引用，V1 建议：

- 不允许物理删除；或
- 将“从当前输入区移除”和“删除 Session 文件”区分。

首版最稳妥的原则：

> 输入框上的“×”默认表示取消本轮引用；只有未被任何消息引用的附件才允许真正删除文件。

如果实现复杂，可在 V1 中限制为：

- 发送前允许删除。
- 发送后历史附件只读，不提供删除。

---

## 11. 前端附件状态模型

当前的 `PendingImage` 应被移除或逐步废弃。

不要继续以：

```ts
type PendingImage = {
  data: string;
  mimeType: string;
};
```

作为发送模型。

可以新增前端状态：

```ts
type PendingAttachment = {
  localId: string;
  file?: File;
  attachment?: SessionAttachment;
  progress?: number;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
};
```

注意：

- `File` 只用于上传阶段。
- 上传成功后，以服务端 `SessionAttachment` 为准。
- 消息发送只允许引用 `status === 'ready'` 的附件。

---

## 12. 前端统一入口改造

将以下逻辑全部改为统一附件入口：

```text
file picker
drag & drop
clipboard
```

统一调用：

```ts
addAttachments(files, source)
```

`addAttachments()` 应负责：

1. 对输入文件做基础规范化。
2. 为无文件名 clipboard 图片生成名称。
3. 添加本地 optimistic attachment item。
4. 发起上传。
5. 更新进度。
6. 上传成功后写入 `SessionAttachment`。
7. 单个失败仅更新该 item 为 error。
8. 通知 Workspace 文件列表刷新。

不要在不同入口分别维护三套上传实现。

---

## 13. 输入框附件 UI

附件添加后，在输入框上方展示附件区域。

### 图片

展示：

- 缩略图。
- 文件名。
- 文件大小。
- 状态。
- 移除按钮。

### PDF

展示：

- PDF 图标。
- 文件名。
- 文件大小。
- 状态。
- 移除按钮。

### DOCX / TXT / Markdown / 代码

展示文档类图标。

### XLSX / CSV

展示表格类图标。

### ZIP / 其他文件

展示对应或通用文件图标。

优先复用现有：

```text
FilePreview.tsx
```

中的：

- 类型识别。
- 图标映射。
- 文件展示逻辑。

避免建立第二套 MIME / extension presentation 映射。

---

## 14. UI 状态要求

至少显示：

```text
uploading
ready
error
```

上传过程中可显示：

- loading。
- 百分比（如果现有请求层方便提供）。

失败时必须：

- 明确标记失败。
- 不允许被作为有效 attachment ID 发送。
- 允许用户移除。
- 可选支持重试。

多附件：

- 自动换行；或
- 横向滚动。

必须适配窄屏和大量附件。

不要因为某一个附件失败隐藏整个附件区域。

---

## 15. WorkspaceDock 联动

上传成功后，右侧文件栏应能看到：

```text
attachments/<attachment-id>/<file>
```

如果 WorkspaceDock 已经基于 Session 目录浏览文件，优先只做刷新通知，而不是建立新的附件文件浏览系统。

上传成功后应触发对应的目录刷新 / invalidation。

---

## 16. 消息协议改造

当前发送协议从 `images` 扩展为 `attachments`。

建议最终输入：

```ts
type SendPromptInput = {
  text: string;
  attachmentIds?: string[];
  // other existing fields...
};
```

不要让前端发送完整：

```ts
SessionAttachment[]
```

更不要发送：

```text
relativePath
absolutePath
base64
```

服务端必须根据 attachment ID 自己解析可信元数据。

---

## 17. 乐观消息、队列和历史消息

以下链路必须同时改造，否则附件系统会在恢复时断裂：

- 当前用户消息。
- optimistic message。
- queued message。
- pending prompt。
- 历史消息序列化。
- Session 恢复。
- 历史消息 UI。

消息需要持久化：

```ts
attachmentIds?: string[];
```

历史 UI 渲染时：

```text
message.attachmentIds
        ↓
Session attachment registry
        ↓
附件展示组件
```

不能继续只读取：

```text
message.images
```

---

## 18. Agent 附件上下文

发送 Prompt 时，服务端根据本轮 `attachmentIds` 生成附件上下文。

示例：

```text
本轮用户消息包含以下会话附件。文件均位于当前任务工作目录内：

1. 交通组织方案.pdf
   相对路径：attachments/att_a1b2c3/交通组织方案.pdf
   类型：application/pdf
   大小：2.4 MB

2. clipboard-20260810-153012-1.png
   相对路径：attachments/att_d4e5f6/clipboard-20260810-153012-1.png
   类型：image/png
   大小：428 KB

请根据用户请求读取所需附件。
不要假定尚未读取的文件内容。
```

要求：

- 只使用相对 Session cwd 的路径。
- 不暴露本机绝对路径。
- 只列出本轮消息引用的附件。
- 内容由服务端生成，不由前端拼接。
- 附件说明只是文件目录，不应假装已经解析文件内容。

---

## 19. Pi 图片集成

对于 `kind === 'image'` 的附件：

1. 原文件必须已经成功落盘。
2. 服务端通过 attachment ID 解析到真实路径。
3. 如果当前 Pi / model 支持 image content：
   - 读取图片。
   - 必要时执行现有尺寸限制或转换策略。
   - 转换成 Pi image content。
4. 同时保留附件上下文中的文件路径。

最终图片具备两个入口：

```text
视觉模型直接看图
+
Agent 以后仍可通过文件路径访问原图
```

应避免前端继续承担 Canvas / Base64 / Pi image 协议转换。

如果现有 Pi API 强制要求 Base64，则 Base64 只应在服务端“发送给 Pi 的最后一步”短暂生成，不应成为浏览器到 Agent Host 的传输协议或持久化格式。

---

## 20. 非图片文件处理

V1 对非图片附件不要求上传接口立即解析。

正确流程：

```text
附件上传
→ 原文件保存
→ Agent 获知路径
→ Agent 根据用户请求决定是否读取
```

不同文件类型后续通过 Attachment Reader / Tool 处理。

---

## 21. 后续 Attachment Reader 适配层

建议后续增加独立抽象，而不是把解析逻辑塞进上传接口。

例如：

```ts
interface AttachmentReader {
  supports(attachment: SessionAttachment): boolean;
  read(
    attachment: SessionAttachment,
    context: AttachmentReadContext
  ): Promise<AttachmentContent>;
}
```

可逐步实现：

```text
TextReader
ImageReader
PdfReader
DocxReader
SpreadsheetReader
PptxReader
ArchiveReader
```

推荐优先级：

1. TXT / Markdown / Source Code / CSV。
2. PDF。
3. DOCX。
4. XLSX。
5. PPTX。
6. ZIP 内容清单。

解析结果建议保存为附件目录下的派生文件：

```text
attachments/
  att_a1b2c3/
    交通组织方案.pdf
    derived/
      text.txt
      metadata.json
```

原则：

> 原始文件始终保留，解析结果只是派生数据。

---

## 22. 文件类型与“理解能力”

首版预期：

| 类型 | 可上传 | 可持久化 | Agent 获知路径 | 首版直接理解 |
|---|---:|---:|---:|---|
| PNG/JPEG/WebP/GIF | 是 | 是 | 是 | 视觉模型支持时是 |
| TXT/MD/代码 | 是 | 是 | 是 | 可通过读取工具 |
| CSV | 是 | 是 | 是 | 可通过文本/表格工具 |
| PDF | 是 | 是 | 是 | 依赖 PDF reader |
| DOCX | 是 | 是 | 是 | 依赖 DOCX reader |
| XLSX | 是 | 是 | 是 | 依赖 spreadsheet reader |
| PPTX | 是 | 是 | 是 | 依赖 PPTX reader |
| ZIP | 是 | 是 | 是 | 首版不保证 |
| 未知二进制 | 是 | 是 | 是 | 不保证 |

不要在 UI 上用“支持上传”暗示“模型一定能够读取内容”。

---

# 23. 分阶段实施计划

## Phase 1：附件基础设施（已完成）

### 目标

让任意普通文件能够安全、可靠、持久化地进入当前 Session。

### 任务

- [x] 新增 `SessionAttachment` 共享类型。
- [x] 增加附件 kind / source / status 定义。
- [x] 新增 Session 附件上传 HTTP API。
- [x] 使用 multipart + stream 写入。
- [x] 为每个附件创建唯一 attachment ID。
- [x] 写入临时文件。
- [x] 计算 size。
- [x] 计算 SHA-256。
- [x] 清理文件名。
- [x] 防止 path traversal。
- [x] 防止 symlink escape。
- [x] 原子移动到 `attachments/<id>/`。
- [x] 创建 / 更新 `.tau/attachments.json`。
- [x] 增加附件查询能力。
- [x] 增加发送前附件删除能力。
- [x] Session 恢复时加载附件索引。
- [x] 增加相关测试。

### Phase 1 验收

- [x] PNG 可以上传。
- [x] PDF 可以上传。
- [x] DOCX 可以上传。
- [x] XLSX 可以上传。
- [x] 未知后缀文件可以上传。
- [x] 文件真实存在于当前 Session。
- [x] 同名文件互不覆盖。
- [x] `../../` 文件名不能逃逸。
- [x] 不完整上传不会出现 ready 文件。
- [x] 单文件失败不会破坏其他附件。

---

## Phase 2：统一前端附件体验（已完成）

### 目标

所有附件入口和 UI 统一，不再围绕 image 编写。

### 任务

- [x] 创建统一 `addAttachments(files, source)`。
- [x] 改造文件选择器支持多文件。
- [x] 移除 image-only 处理限制。
- [x] 改造 drag & drop。
- [x] 改造 clipboard files。
- [x] 支持无文件名 clipboard image。
- [x] 生成 clipboard 文件名。
- [x] 做 clipboard 基本去重。
- [x] 创建 `PendingAttachment` 状态。
- [x] 上传时显示 optimistic item。
- [x] 展示 uploading / ready / error。
- [x] 图片展示缩略图。
- [x] 文档展示文件类型图标。
- [x] 复用现有 FilePreview 类型映射。
- [x] 单项移除。
- [x] 多附件布局。
- [x] 上传成功后刷新 WorkspaceDock。
- [x] 删除或废弃 `processImage()` 的上传职责。
- [x] 删除或废弃前端 Base64 attachment pipeline。

### Phase 2 验收

- [x] Picker 单文件正常。
- [x] Picker 多文件正常。
- [x] Drop 单文件正常。
- [x] Drop 多文件正常。
- [x] 粘贴系统截图正常。
- [x] 粘贴 Finder / Explorer 文件正常。
- [x] 粘贴多个文件正常。
- [x] 无文件名图片自动命名。
- [x] 一个上传失败不影响其他 item。
- [x] 成功文件能在 WorkspaceDock 中看到。

---

## Phase 3：消息与 Agent 集成（已完成）

### 目标

附件真正成为用户消息的一部分，并且 Agent 能可靠知道和使用附件。

### 任务

- [x] `SendPromptInput` 增加 `attachmentIds`。
- [x] 前端发送时只提交 ready attachment IDs。
- [x] optimistic message 保存 attachment IDs。
- [x] queued message 保存 attachment IDs。
- [x] pending message 保存 attachment IDs。
- [x] 历史消息序列化 attachment IDs。
- [x] Session 恢复恢复 attachment refs。
- [x] 用户历史消息展示附件卡片。
- [x] 服务端验证附件归属。
- [x] 服务端 resolve attachment IDs。
- [x] 服务端生成本轮附件上下文。
- [x] 附件上下文使用相对路径。
- [x] 图片附件转换为 Pi image content。
- [x] 图片原始文件仍然保留。
- [x] 移除 WebSocket Base64 图片传输。
- [x] 修复当前历史图片只读取 `message.images` 的不完整链路。

### Phase 3 验收

用户可以：

```text
拖入 PDF + XLSX + Screenshot
→ 输入问题
→ 发送
```

系统必须做到：

- [x] 三个附件均已真实落盘。
- [x] 消息发送只携带 attachment IDs。
- [x] 用户消息显示三个附件。
- [x] Agent 能看到三个附件名称。
- [x] Agent 能看到安全相对路径。
- [x] 截图进入视觉模型。
- [x] PDF/XLSX 可由后续工具按路径读取。
- [x] 刷新页面后消息附件仍显示。
- [x] 恢复 Session 后文件仍存在。
- [x] 后续消息中 Agent 仍可读取原附件文件。

---

## Phase 4：文件理解适配器（后续范围，未纳入 V1）

### 目标

逐步提高 Agent 对不同文件格式的内容读取能力。本阶段不影响附件 V1 完成；当前版本通过现有读取工具和 `FilePreview` 提供按需读取与预览，专用 Reader / derived 文件生成留待后续迭代。

### 任务顺序

#### 4.1 文本类

- [ ] TXT。
- [ ] Markdown。
- [ ] Source Code。
- [ ] CSV。

#### 4.2 PDF

- [ ] 引入可靠 PDF 文本提取能力。
- [ ] 支持页数 / 基础 metadata。
- [ ] 必要时生成 `derived/text.txt`。

#### 4.3 DOCX

- [ ] 提取段落。
- [ ] 提取表格基本内容。
- [ ] 生成派生文本。

#### 4.4 XLSX

- [ ] 枚举 worksheet。
- [ ] 获取 sheet dimensions。
- [ ] 生成 worksheet 摘要。
- [ ] Agent 可按需读取具体工作表。

#### 4.5 PPTX

- [ ] 提取 slide text。
- [ ] 保留 slide number。

#### 4.6 Archive

- [ ] ZIP 内容清单。
- [ ] 默认不自动解压执行内部文件。

---

# 24. API 建议

以下仅作为参考，应优先匹配项目现有 API 命名规范。

## 上传

```http
POST /api/sessions/:sessionId/attachments
Content-Type: multipart/form-data
```

响应：

```json
{
  "attachments": [
    {
      "id": "att_a1b2c3",
      "name": "交通组织方案.pdf",
      "relativePath": "attachments/att_a1b2c3/交通组织方案.pdf",
      "mimeType": "application/pdf",
      "size": 2516582,
      "sha256": "...",
      "kind": "pdf",
      "source": "picker",
      "status": "ready"
    }
  ]
}
```

多文件时建议返回逐文件结果，避免单个失败影响全部。

---

## 查询

```http
GET /api/sessions/:sessionId/attachments
```

用于：

- Session 恢复。
- 历史消息 attachment ref 解析。
- Workspace / Conversation 初始化。

---

## 删除

```http
DELETE /api/sessions/:sessionId/attachments/:attachmentId
```

仅允许删除符合当前产品规则的附件。

---

# 25. 建议重点搜索和检查的现有代码

Coding Agent 开始改造前，先完整搜索以下内容：

```text
processImage
PendingImage
prompt.images
message.images
images:
FileReader
readAsDataURL
canvas.toDataURL
clipboardData
DataTransfer
onDrop
accept="image
WorkspaceDock
FilePreview
filePresentation
SendPromptInput
queued message
optimistic message
session.cwd
WebSocket
```

目标是找到所有 image-only 假设，而不是只修改 `ConversationWorkspace.tsx` 一处。

---

# 26. 迁移原则

不要一次性删除旧图片逻辑后再重建。

建议迁移顺序：

```text
1. 建立新附件服务端能力
2. 新前端上传入口接入
3. 图片也开始走附件落盘
4. 消息增加 attachment IDs
5. 服务端图片通过附件生成 Pi image
6. 验证新链路稳定
7. 删除旧 PendingImage/Base64 WebSocket 链路
```

这样可以降低一次性重构风险。

---

# 27. 测试要求

## 服务端单元 / 集成测试

至少覆盖：

- [ ] 单文件上传。
- [ ] 多文件上传。
- [ ] 空文件。
- [ ] 大文件限制。
- [ ] 同名文件。
- [ ] Unicode 文件名。
- [ ] 中文文件名。
- [ ] 无扩展名。
- [ ] 未知 MIME。
- [ ] `../` 文件名。
- [ ] 绝对路径文件名。
- [ ] 中途中断上传。
- [ ] SHA-256 正确。
- [ ] attachments index 恢复。
- [ ] attachment 不属于当前 Session。
- [ ] 不存在 attachment ID。
- [ ] symlink/path escape。

## 前端测试

至少覆盖：

- [ ] picker single。
- [ ] picker multiple。
- [ ] drop single。
- [ ] drop multiple。
- [ ] paste screenshot。
- [ ] paste file。
- [ ] paste multiple files。
- [ ] upload error。
- [ ] remove before send。
- [ ] attachment UI after send。
- [ ] history restore。

## Agent 集成测试

至少覆盖：

- [ ] 图片仍可被视觉模型看到。
- [ ] Agent prompt 中存在本轮附件目录。
- [ ] 非本轮附件不应错误注入。
- [ ] Agent 获得的是相对路径。
- [ ] 前端伪造 path 无效。
- [ ] 前端伪造其他 Session attachment ID 无效。

---

# 28. 首轮完整验收标准

V1 完成时，以下全部成立：

- [ ] PNG 文件可以上传。
- [ ] 剪贴板截图可以上传。
- [ ] PDF 可以上传。
- [ ] DOCX 可以上传。
- [ ] XLSX 可以上传。
- [ ] 未知后缀普通文件可以上传。
- [ ] 文件选择支持一个或多个附件。
- [ ] 拖拽支持一个或多个附件。
- [ ] 剪贴板支持一个或多个文件 / 图片。
- [ ] 上传后附件立即出现在输入框上方。
- [ ] 每个附件独立展示上传状态。
- [ ] 单个失败不影响同批其他文件。
- [ ] 图片显示缩略图。
- [ ] 文档显示正确类型图标。
- [ ] 未发送附件可以移除。
- [ ] 文件真实存在于当前 Session 的 `attachments/`。
- [ ] 文件不会因为重名发生覆盖。
- [ ] 文件无法写出 Session 工作目录。
- [ ] 消息通过 attachment ID 引用附件。
- [ ] WebSocket 不再传输附件 Base64。
- [ ] Pi 能看到附件名称和安全相对路径。
- [ ] 图片仍能被视觉模型接收。
- [ ] 发送后的用户消息显示附件。
- [ ] 刷新后历史附件仍显示。
- [ ] Session 恢复后附件仍可读取。
- [ ] WorkspaceDock 能看到成功上传的文件。

---

# 29. 最终用户场景

本次改造完成后，应支持以下完整场景：

用户在一个 Agent Session 中：

1. 拖入一个 PDF。
2. 拖入一个 XLSX。
3. 粘贴一张系统截图。
4. 输入：

```text
结合这三个文件，帮我检查方案中的数据有没有问题。
```

系统执行：

```text
PDF ───────┐
XLSX ──────┼→ HTTP 上传 → 当前 Session attachments/
Screenshot ┘

                  ↓

           返回 attachment IDs

                  ↓

         输入框展示 3 个附件

                  ↓

             用户点击发送

                  ↓

WebSocket prompt:
  text
  attachmentIds[]

                  ↓

       服务端验证 attachment IDs

                  ↓

   解析 SessionAttachment / 相对路径

                  ↓

       生成本轮附件上下文

                  ↓

Screenshot → Pi image content
PDF/XLSX   → 文件路径供工具读取

                  ↓

               Pi Agent
```

刷新页面或恢复 Session 后：

```text
历史用户消息
→ 仍显示 3 个附件
→ 文件仍存在于 Session
→ Agent 后续仍可再次读取
```

---

# 30. Coding Agent 执行要求

实现过程中请遵守以下原则：

1. **先阅读现有协议和消息持久化链路，再修改。**
2. **不要只修改 UI。附件必须真正落盘。**
3. **不要继续扩展 `processImage()`。**
4. **不要将任意文件 Base64 放进 WebSocket。**
5. **不要信任前端提交的路径。**
6. **attachment ID 必须与当前 Session 绑定验证。**
7. **图片也必须落盘，视觉输入只是附加能力。**
8. **优先复用 `FilePreview` / `WorkspaceDock` 已有类型展示能力。**
9. **上传和文件解析必须解耦。**
10. **每完成一个 Phase，先确保对应验收项通过，再继续下一阶段。**
11. **发现现有消息模型、Pi 协议或 Session 持久化机制与本文假设不同时，以代码真实结构为准，但必须保持本文的架构目标。**
12. **不要为实现 V1 引入不必要的 RAG、OCR、全文索引或文档数据库。**

---

# 31. 架构定义

本次改造可以归纳为：

> 将现有基于 Base64 的临时图片输入机制，重构为 Session 级统一附件系统：附件通过独立上传接口持久化到当前会话工作目录，消息仅引用附件 ID，服务端负责验证附件归属、解析安全相对路径并向 Agent 注入附件上下文；图片额外进入视觉输入，其他文件由独立解析工具按需读取。

实现是否成功，最终只看四件事：

```text
上传持久化
→ 消息引用
→ Agent 可寻址
→ 历史可恢复
```

四项同时成立，才算完成本次附件系统改造。
