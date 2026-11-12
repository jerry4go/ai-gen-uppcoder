# AI 生图 / 生视频（简化版）

从 basketikun/infinite-canvas 简化而来，**没有画布、没有节点、没有连线、没有 Agent、没有插件、没有音频**。
就是一个最简单的生成器：提示词在上，生成结果在下。

## 功能

- **前台**：选生图 / 生视频 → 选渠道和模型 → 输提示词 → 点生成，结果在提示词框下面
  - 图片卡片：`用这张图生成视频`（这张图作首帧，提示词填回框里可改）、`编辑提示词`、下载、删除
  - 生视频时可上传本地图片作首帧（参考图）
  - 生图支持数量 1/2/4、尺寸选择；生视频支持时长、尺寸选择
- **后台**：登录验证后才能进
  - 首次登录账号 `admin` / 初始密码 `admin123`，**登录后必须先修改密码**才能管理渠道（密码加盐哈希存在服务器 `./data/auth.json`，仓库里没有任何密码）
  - 渠道管理：添加 / 编辑 / 删除 / 启用 / 停用 / 设默认 / 测连接；字段：名称、Base URL、API Key、生图模型、生视频模型、能力（生图/生视频）
  - **模型不能手填**：填好 Base URL 和 API Key 后点“获取模型列表”，生图模型 / 生视频模型只能从渠道 `/models` 接口返回的模型里下拉选择；没返回模型或获取失败时下拉框保持禁用，保存时服务端也会再校验一次模型在不在列表里
  - Key 只存在服务器，列表和前台只显示掩码（`********` + 后 4 位）
- **生成走服务器代理**：前台不直接调模型渠道；图片走 `POST {Base URL}/images/generations`（有参考图时走 `/images/edits`），视频走 `POST {Base URL}/videos` 异步任务 + 轮询，完成后把文件下载到服务器 `./data/media/` 再播放/下载，模型那边链接过期也不影响。
- **异步生成，不会假报错**：点“生成”后服务端立即返回一条 `generating` 状态的记录，前台显示“生成中（模型那边还在生成，请稍等）…”并每 2.5 秒轮询，直到记录翻转为完成或失败才显示结果。渠道侧一次生图常需 30–90 秒以上（muse2api 驱动 Muse 网页），旧版 20 秒超时会误报 `This operation was aborted`，现在不会了；同时单次调用超时也已放宽（生图 600 秒、生视频创建 300 秒、下载 180 秒）。
- **渠道 HTTP 错误不重试，只有没收到响应的传输层失败才重试 1 次**：收到渠道返回的 HTTP 错误（502/503/504/429/401/403/404/400 等）时立即按原样记失败，一次都不重试——`/images/generations` 是同步接口，渠道收到 POST 就会立刻开始生成，它报 502 时生成其实已经在渠道侧启动了，再发一次 POST 不是“恢复第一张图”，而是又烧一次全新的生成（2026-11-12 实测：重试 3 次导致渠道侧直接生成了 3 张照片，第一张还丢了）。想再试由用户手动点生成。只在根本没收到任何 HTTP 响应时（fetch 失败、连接被重置、超时 abort）才重试 1 次（共 2 次调用），间隔 10 秒，记录保持 `generating` 并显示“连接失败，正在重试…”。视频任务的创建重试在创建步骤内部做，轮询和取回步骤失败绝不重发创建调用（会建重复任务）。服务重启/重新部署时，之前还在 `generating` 的记录会被标记为失败并写明“被中断，请重新生成”，不会一直转圈。 - **已知问题**：1314 muse2api 渠道目前生图时返回 HTTP 502 "The sandbox service disconnected or is unavailable."，即使请求格式已与原版 infinite-canvas 完全一致（见下一条）也一样。剩余怀疑点是请求来源不同：原版是浏览器直接调渠道，简化版是 Uppcoder 服务器代调（数据中心 IP、Node fetch 请求头）。前台直调（像原版一样由浏览器直接调渠道）的兜底方案暂未实现——那会把 Key 暴露用户自己的浏览器里，需要用户决定。- 

- **请求格式与原版 infinite-canvas 完全一致**：生图（`/images/generations`、`/images/edits`）都带 `response_format: "b64_json"` + `output_format: "png"`（gpt-image 模型按原版省略 response_format，它本来就返回 b64），图片以内联 base64 在同一次响应里返回，不走沙箱 URL 下载——不加 response_format 时 muse2api 返回的是沙箱服务上的 URL，后续下载会报 502 "The sandbox service disconnected or is unavailable."。生视频（`/videos`）按原版补齐 `ratio`（由尺寸推断，auto 时省略）、`resolution_name: "720p"`、`generate_audio: "true"`、`watermark: "false"`、`mode: "frames"`。  

## 部署到 Uppcoder（Spark 免费版）

见 `README_UPPCODER.md`。要点：纯 Node.js、零依赖、无数据库，`node server.js`，端口 8000，`/app/` 子路径已处理。

## 本地运行

```bash
node server.js
curl http://127.0.0.1:8000/api/health
# 打开 http://127.0.0.1:8000/
```

先在后台添加一个 OpenAI 兼容渠道才能生成。注意：DeepSeek 只有对话模型，不能生图/生视频；要选支持图片/视频生成的渠道和模型。

## 数据

- `./data/auth.json`：管理员账号（哈希密码）
- `./data/channels.json`：渠道（含 Key，**不要提交到仓库**）
- `./data/generations.json`：生成记录
- `./data/media/`：下载下来的图片/视频文件

Uppcoder 容器重建后 `./data/` 会丢失，记得定期备份。
