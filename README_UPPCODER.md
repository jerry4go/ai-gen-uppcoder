# 部署到 Uppcoder（Spark 免费版）

## ⚠️ 先看这条：1 个 Stack 的冲突

Uppcoder Spark 免费版一个账号只有 **1 个常驻 Stack**。

本服务部署在**第二账号（zujuan-tongtong）**上，该账号目前的 Stack 是
智能组卷助手 `zujuan-uppcoder`。部署前必须先**删除 `zujuan-uppcoder` 这个 Stack**
（用户已确认不用备份，题库数据随之删除），腾出位置再建新 Stack。

**不要动第一账号（tongtong）上的 Kaveyl Wiki。**

## 部署步骤

1. 把本目录推到 GitHub（新建公开仓库 `jerry4go/ai-gen-uppcoder`，分支 `main`）
   ```bash
   cd ~/workspace/ai-gen-uppcoder
   git init && git add . && git commit -m "AI 生图/生视频（简化版）"
   git remote add origin https://github.com/jerry4go/ai-gen-uppcoder.git
   git push -u origin main
   ```
   注意：`data/` 和 `.env` 已在 `.gitignore` 里，不会推上去。仓库里没有任何密码和 Key。

2. 用第二账号（zujuan-tongtong）登录 Uppcoder → 删除 Stack `zujuan-uppcoder` → 新建 Stack → 选 **Blank / Node.js**（不要选 Docker，不要加数据库组件）
   - 仓库连上面那个 GitHub 仓库，分支 `main`
   - Node 版本选 26（本服务要求 Node ≥ 20，`engines` 已写）
   - **不要加数据库**：数据存在 `./data/*.json` 和 `./data/media/`，不需要数据库组件

3. 构建 / 启动设置
   - Build 命令：留空，或 `npm install`（本项目零依赖，装了也是空操作）
   - Start 命令：`node server.js`
   - 端口：`8000`（服务监听 `process.env.PORT || 8000`）

4. 访问地址
   - Uppcoder 会给一个公开域名，根路径 `/` 是开发环境页，**应用在 `/app/`**
   - 打开 `https://<你的域名>/app/` 即可用
   - 本服务已处理子路径：`/app/api/...` 和 `/api/...` 都能用，前端资源全是相对路径，不用改代码
   - 打开后点右上角“公开访问”，让页面不用登录 Uppcoder 也能打开

5. 首次使用（必须做）
   1. 点“后台 · 渠道配置”，用 `admin` / `admin123` 登录
   2. **先修改密码**（不改进不去渠道管理），改完用新密码重新登录
   3. 添加渠道：名称、Base URL、API Key、生图模型、生视频模型，勾能力，保存后点“测连接”
   4. 回到前台，选渠道和模型，输提示词，点生成

## 进程保活

Uppcoder 的 Stack 本身会拉起 `node server.js`。如果发现关掉终端后应用就死了，
用 `setsid nohup` + 看门狗的办法（参考组卷助手的 `~/zujuan-watchdog.sh` 模式）：
看门狗每 30 秒 curl 一次 `/app/api/health`，不通就重启服务。

## 数据持久化警告

- 渠道、生成记录和生成的文件存在容器里的 `./data/`
- **容器重建 / 重新部署后数据会丢**，Uppcoder 免费版不保证持久化
- 备份办法（部署后定期做）：把服务器 `./data/` 整个拷出来；或从前台逐个下载生成结果。

## 本地先验证（推仓库之前）

```bash
node server.js
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/ | head -5
# 管理员登录（首次必须改密码）：
curl -X POST http://127.0.0.1:8000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'
```
