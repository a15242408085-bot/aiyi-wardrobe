# 爱衣橱后端本地开发

从 `app` 目录启动，后端只监听 `127.0.0.1:8000`。

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-local.lock
backend/.venv/bin/python scripts/start_backend.py
```

同时启动网页与后端可用 `node scripts/start_local.mjs`。首次启动创建 `backend/.local/wardrobe.sqlite3`、媒体目录和随机服务端密钥，重启保留数据。`.local/` 已忽略，不要提交其中的密钥、图片或用户数据。

API 文档为 `http://127.0.0.1:8000/docs`，健康检查为 `/api/v1/health/ready`。`/api/v1/capabilities` 仍描述上游能力；新增三个工作流服务的就绪状态应读取 `/api/v1/ai/services`。

## 本地数据与工作流

- 原开发登录及用户隔离：`POST /api/v1/auth/sync`。
- 原衣物上传、编辑、查询、筛选、喜欢和删除：`/api/v1/items`。
- 衣物图片权限与签名读取：`/api/v1/images/{user_id}/{filename}`。
- 手动搭配保存：`POST /api/v1/outfits/studio`，输入 `items,occasion,name?`。
- 新增 `recognition`：结构化识别、原图裁剪、可选逐件单品图、用户确认入库。
- 新增 `catalog`：已有衣物单品图生成、原图对照、显式应用及并发/原图变更保护。
- 新增 `model`：保存用户上传的人物图，无云端生成请求。
- 新增 `try_on`：人物上传或 `model_id` 二选一，搭配 1–5 件单品调用图片服务；上衣、外套、下装、鞋、包每类最多一件。
- 新增 `rotation`：用户视频本地导入，或模特/试穿图经 WaveSpeed 生成视频；均本地抽取 61 帧供网页展示。

详细字段与 HTTP 返回见 [AI 工作流契约](../docs/ai-workflows.md)。这些实现参考 WOO 的功能流程，没有复制其 Swift、图片资源或服务端源码。

## 独立服务设置

网页 `/workspace/settings` 分别配置 `recognition`、`image`、`rotation`；接口为 `GET /ai/services`、`PUT /ai/services/{service}`、`DELETE /ai/services/{service}/key` 和 `POST /ai/services/{service}/check`，均在 `/api/v1` 下。

识别与图片支持 OpenAI、OpenAI 兼容、Gemini 原生 `generateContent`。衣物识别还支持独立 DeepSeek（`deepseek`）provider（预填 `https://api.deepseek.com`、`deepseek-flash`），不允许用于图片/视频生成；本机官方识别配置已加密保存，`GET /models` 能列出 `deepseek-flash`，但尚未上传真实图片推理。视频支持 WaveSpeed；本地保存模特和导入视频不需要云端密钥。未配置相应服务时，云端任务接口返回明确错误，不创建伪成功结果。

配置文件保存在 `.local/aiyi-config`，按用户和服务分文件，密钥由 Fernet 加密。密钥派生依赖本机服务端 secret，默认保存在 `.local/secrets.json`；备份配置时应一起保留服务端 secret。GET 不返回密钥，前端提交后清空输入，不写入浏览器存储。更换 provider 或 base_url 时不会自动沿用原目标的密钥。

旧 `/ai/settings` 和环境配置仍保留兼容。`AIYI_API_KEY`、`AIYI_PROVIDER`、`AIYI_BASE_URL`、`AIYI_VISION_MODEL`、`AIYI_IMAGE_MODEL`、`AIYI_QUALITY` 用于旧配置；OpenAI 官方地址下支持 `OPENAI_API_KEY`。在没有单独保存对应服务配置时，recognition/image 会读取这些旧默认值。单独保存后不再共用该回退；rotation 默认没有密钥，应通过网页或服务设置 API 配置。不要把真实密钥写进仓库或示例命令。

当前 `recognition` 已配置 DeepSeek，`image` 保留原有可用的 `gpt-image-2` 配置，`rotation` 未配置。新提供的 GPT 密钥未列出图片模型，未替换现有图片密钥。

连通检查只检查访问和模型存在情况，不生成图片或视频。不能把旧图片密钥可用推断为识别权限也可用。

## 视频依赖与限制

`requirements-local.lock` 包含 `imageio-ffmpeg==0.6.0`。处理程序优先使用系统 `ffmpeg`，没有时调用该包的二进制；工具缺失时返回可读错误。

导入只接受 MP4/MOV，最大 100 MB、30 秒、最长边 4096、总像素 8,000,000。服务器验证媒体容器，使用受限本地 FFmpeg 输入，不跟随远程播放列表或外部 MOV 数据引用。输出 61 张 PNG；默认保留原背景，`remove_green=true` 才去除绿色。绿色衣物可能受影响，没有自动 Apple Vision 人物抠图或真实 3D 重建。

视频与帧通过 `/api/v1/ai/media/{user_id}/{filename}` 读取，要求同用户鉴权或有效签名，服务器不向网页暴露本地文件路径。接口响应中的签名 URL 可直接用于网页图片与视频元素。

## 恢复与重试

任务记录位于 `ai_tasks` 表，历史分页返回 `jobs,total,has_more,next_offset`。执行器为本机单进程异步 worker，同时处理至多两个任务。

排队任务在重启后继续。已开始但结果不明的图片生成标为 interrupted，不能自动重发以免重复计费。识别中已经完成的单品图会保留，重试不重新生成成功结果。转身任务保存了远端编号时继续查询同一视频；已有本地视频时继续抽帧。这两种转身状态可在启动后自动恢复。请求已发出但没有收到有效远端编号时会记录提交结果不明，拒绝直接重复提交，需要用户先核对服务商记录。

本地模式继续关闭上游内部 AI、Redis 队列、后台人物抠图和偏好学习。新增工作流使用独立 adapter；AI 穿搭推荐、身体数据生成模特尚未实现。

## 生产边界

只有 `LOCAL_DEVELOPMENT=true`、`DEBUG=true`、关闭上游内部 AI 并使用 SQLite URL 时才启用本地路径。开发登录没有密码，只适合单机体验。

生产默认的 PostgreSQL、Redis 和 Alembic 路径仍保留，PostgreSQL 的 ARRAY/JSONB 存储不变。SQLite 首次使用 `create_all` 创建缺失表，不处理未来的字段迁移。公开发布前需要正式认证、迁移方案和独立任务 worker。

## 验证

```sh
cd backend
.venv/bin/python -m pytest local_tests -q
```

本轮最终回归 70 项本地测试通过。测试使用临时 SQLite 和用户媒体目录，覆盖基础衣橱、服务配置、原生 Gemini 请求格式、OpenAI 图片编辑、识别确认、单品图应用、模型库、试穿、任务恢复、WaveSpeed 同编号续查、真实视频解码抽帧、权限边界、视频提交结果不明保护及损坏配置重新填入密钥；云端响应为测试替身。上游 `tests/` 仍依赖 PostgreSQL。

前端 21 项交互测试与 TypeScript 已通过。新版生产构建及本地浏览器 QA 已通过。已有图片服务真实调用成功一次，但真人生成保真尚未验收；Gemini 和 WaveSpeed 尚无对应密钥进行真实验收。
