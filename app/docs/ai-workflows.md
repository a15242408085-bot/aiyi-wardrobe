# 爱衣橱 AI 工作流

更新于 2026 年 10 月 16 日。本地工作台已实现衣物识别、单品图、模特库、虚拟试穿和视频帧转身展示。WOO 用于参考功能流程；这些网页和后端实现是本项目新增代码，没有复制 WOO 的 Swift 实现、资源或服务端源码。

现有 DeepSeek 与图片服务已用真实商品图、真人照片完成一次网页识别入库和高质量试穿流程，结果保存、刷新恢复与下载均通过；具体偏差见文末实测记录。Gemini 识别/原生图片能力与 WaveSpeed 视频尚无相应密钥进行真实验收。此前生产构建及本地浏览器 QA 已通过。

## 三个独立服务

在 `/workspace/settings` 分别配置以下服务。每项各有 provider、base_url、model、quality 和密钥，不要求三项同时就绪。

| 服务键 | 网页名称 | 用途 | 可选 provider |
| --- | --- | --- | --- |
| `recognition` | 衣物识别 | 衣物结构化识别和候选定位 | `openai`、`openai_compatible`、`gemini`、`deepseek` |
| `image` | 单品图与试穿 | 单品图生成和多图试穿 | `openai`、`openai_compatible`、`gemini` |
| `rotation` | 360 视频 | 图片生成转身视频 | `wavespeed` |

界面切换服务商时使用的预填值如下。这些是当前代码的配置建议，账户权限和模型可用性仍需检查。

| 服务商 | API 基础地址 | 识别模型预填值 | 图片或视频模型预填值 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | `gpt-image-1.5` |
| Gemini 原生 | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.5-flash` | `gemini-3.1-flash-image` |
| DeepSeek 识别 | `https://api.deepseek.com` | `deepseek-flash` | 不用于图片或视频生成 |
| WaveSpeed | `https://api.wavespeed.ai/api/v3` | 不适用 | `bytedance/seedance-2.0/image-to-video` |

DeepSeek 使用专门的识别适配分支，结构化输出采用 `json_object`，不套用 OpenAI 的 `json_schema` 请求格式。官方识别密钥已加密保存；已真实识别蓝色丝绒交叉 V 领系带短袖上衣并确认入库。模型返回的通用 `top` 类别在衣橱中统一显示“上衣”，计数、筛选、搜索和编辑均支持。

当前 `image` 继续使用原先可用的 `gpt-image-2` 服务配置。用户新提供的 GPT 密钥未列出图片模型，因此未替换已有图片密钥；`rotation` 仍未配置。

兼容服务的地址和模型名由用户填写。图片服务已配置不会直接启用缺少识别配置的上传按钮；导入模特照片和本地视频不需要任何云端密钥。

密钥按用户及服务分别加密保存。保存后网页输入框清空，GET 接口不返回密钥，不使用浏览器本地存储。只有 provider 与 base_url 都未改变时，空密钥才保留该服务原有密钥；改变目标时不把旧密钥自动转发给新服务。删除某服务密钥会保留该服务的无密钥配置，不再使用其旧配置回退。

旧 `/ai/settings` 接口仍保留兼容。在尚未单独保存 `recognition` 或 `image` 配置的旧安装中，这两项会从旧配置读取默认值；分别保存后独立管理。`rotation` 默认没有密钥。

连通性检查不生成图片或视频。OpenAI 与 DeepSeek 路径读取模型列表，Gemini 查询所选模型，WaveSpeed 检查账户访问与模型列表。网页分别显示每项的 `model_listed`；未列出时提示核对模型名或权限，不直接断言推理不可用。

## 用户操作与结果

### 衣物识别和可选单品图

上传单件衣物图、穿搭照片或多件单品拼图，模型返回名称、类型、颜色、季节、材质、备注和归一化边界框。服务器在有效识别框四周分别增加原图宽/高 2.5% 的安全边距，向外取整并限制在图内，以减轻袖口、包底等被紧框截掉的问题；这仍不保证框完全准确。无法合理裁剪时保留整图并提示。用户编辑和勾选后才确认入库。

“同时生成干净单品图”默认关闭，需要 `recognition` 和 `image` 都已配置才可使用。开启后按上衣、外套、下装、鞋、包五个大类去重，每类最多保留一件，然后分别生成单品图。每件可能产生一次独立图片调用。生成状态逐件保存，重试不会重做已有成功结果；部分失败时保留该件原图或裁剪图，并通过 `generation_error` 提示，其他候选仍可确认。

生成图片标记为 `image_kind=generated`，保留原图入口供对照。候选不被描述为精确抠图，生成内容也不被视为已经验证保真。

### 已入库衣物的单品图

用户选已有衣物提交 `catalog` 任务，完成后并排查看原图与生成图。只有点击确认应用，服务器才替换衣橱主图。任务保留原图参考，应用具有幂等和并发保护；如果衣物主图路径或内容已变化，返回 409 要求重新生成，避免旧结果覆盖更新后的衣物。

### 模特库与试穿

`model` 记录保存人物照片或写实模特图及名称，上传成功即完成，无 AI 调用。试穿必须在上传 `person_image` 与选择 `model_id` 中二选一，并提供自己衣橱中 1–5 件不同单品：上衣、外套、下装、鞋、包每类最多一件。连衣裙、套装和其他类别暂不在试穿范围。包的生成指令允许手指和手腕为自然握持做小幅调整，并要求合理的包带与衣服遮挡关系。

图片 provider 将人物图排第一、衣物图按选择顺序排列，并要求保留人物身份、体型、姿势和衣物细节。这里是生成指令，不是对结果的保证。返回图片验证通过后保存到当前用户目录，任务历史可恢复、分页查看和下载。

### 360 转身展示

从已完成的 `model` 或 `try_on` 记录发起云端转身，后端上传来源图、提交视频任务、保存远端任务编号、轮询、下载视频，最后本地抽取 61 张 PNG。当前 WaveSpeed 请求设为固定镜头、9:16、480p、4 秒、首尾参考图相同，关闭音频与联网搜索；这些请求参数尚未通过本机视频密钥实际验证。

另一路径是直接导入用户自己的 MP4/MOV。限制为 100 MB、30 秒、最长边 4096、总像素不超过 8,000,000；服务器验证容器并使用 FFmpeg 解码，覆盖视频时段抽取 61 帧。该路径不调用云端生成服务。优先使用系统 FFmpeg，否则使用 `imageio-ffmpeg` 提供的二进制。

两条路径的 `remove_green` 均默认 false，只有用户明确勾选才去绿幕。当前没有实现 WOO 的 Apple Vision 本机前景抠图，也不自动把普通背景变成透明背景。绿幕处理可能影响绿色衣物，结果需要检查。

网页查看器只使用服务端返回的实际 `frame_urls`，支持左右拖动、滑条、前后帧和自动播放，无帧时显示缺失提示。它是视频帧序列展示，不提供真实 3D 人体网格、尺码模拟或物理布料仿真。

## API 契约

路径均以 `/api/v1` 为前缀；配置、任务和创建接口要求现有 Bearer 登录，新增工作流只在本地开发模式开放。图片、视频及帧资源通过所属用户鉴权或有效签名 URL 读取。

### 服务配置

- `GET /ai/services` → `{recognition: ServicePublic, image: ServicePublic, rotation: ServicePublic}`。
- `PUT /ai/services/{service}`：JSON `{provider,base_url,model,quality,api_key?}`，返回该项 `ServicePublic`。
- `DELETE /ai/services/{service}/key`：清除该服务密钥，返回该项公开配置。
- `POST /ai/services/{service}/check` → `{status,message,model_listed?}`；某些 adapter 还保留兼容字段。
- `ServicePublic`：`configured,provider,base_url,model,quality,key_source`，其中 `key_source` 为 `saved|environment|none`。
- 旧 `GET/PUT /ai/settings`、`DELETE /ai/settings/key`、`POST /ai/settings/check` 继续保留兼容，新网页使用三服务接口。

### 创建与确认

| 接口 | 输入 | 返回 |
| --- | --- | --- |
| `POST /ai/recognitions` | multipart `image,generate_product_images=false` | 202，recognition 任务 |
| `POST /ai/recognitions/{id}/confirm` | JSON `{candidates:[{candidate_id,name,type,colors,primary_color,season,material,notes}]}` | 更新后的任务；重复确认不重复入库 |
| `POST /ai/catalog-images` | multipart `item_id` | 202，catalog 任务 |
| `POST /ai/catalog-images/{id}/apply` | 无请求体 | 确认应用后的任务 |
| `POST /ai/models` | multipart `name,image` | 201，已完成的 model 记录 |
| `POST /ai/try-ons` | multipart `person_image` 或 `model_id`，以及 `item_ids` JSON 字符串数组、可选 `prompt` | 202，try_on 任务 |
| `POST /ai/rotations/import` | multipart `video,name,remove_green=false` | 202，本地导入 rotation 任务 |
| `POST /ai/rotations` | multipart `source_job_id`、可选 `name,remove_green=false` | 202，云端 rotation 任务 |
| `POST /ai/jobs/{id}/retry` | 无请求体，仅 failed/interrupted 可用 | 202，重试任务 |

`GET /ai/jobs?kind=recognition&offset=0&limit=30` 返回 `{jobs,total,has_more,next_offset}`。`kind` 可为 `recognition|try_on|catalog|model|rotation` 或省略；按创建时间从新到旧，最后一页 `next_offset=null`。`GET /ai/jobs/{id}` 返回当前用户单个任务。

通用任务字段为 `id,kind,status,stage,progress,attempt,source_image_url,result,error,created_at,updated_at`。状态是 `queued|running|awaiting_confirmation|completed|failed|interrupted`，进度只代表真实处理阶段，不估计服务商还需多少秒。

| kind | result 主要字段 |
| --- | --- |
| recognition | `candidates`；确认后增加 `item_ids`。候选含 `candidate_id,name,type,colors,primary_color,season,material,notes,image_url,source_image_url,image_kind,crop_warning,generation_status,generation_error`，部分字段可空或缺省 |
| try_on | `image_url,item_ids,model_id?` |
| catalog | `image_url,item_id,applied` |
| model | `image_url,name` |
| rotation | `origin,name,remove_green,source_job_id?`；完成后有 `frame_urls,video_url,frame_count`，`frame_count=61` |

原始文件路径和远端视频任务编号不返回给网页。客户端确认请求不能指定服务器文件路径。转身视频与 PNG 帧通过签名的 `/ai/media/{user_id}/{filename}` 读取。

## Adapter 和任务执行

- `backend/app/services/aiyi_provider.py`：OpenAI/兼容路径及原生 `GeminiProvider`，实现 `analyze`、`product_image`、`try_on`。
- OpenAI 识别调用 `/chat/completions`，使用图片输入和 JSON schema；图片调用 `/images/edits`，多图字段为 `image[]`。单品图请求 `1024x1024`，试穿 `1024x1536`，质量来自配置。仅 `gpt-image-1` 与 `gpt-image-1.5` 自动加 `input_fidelity=high`。当前要求 `data[0].b64_json`，不把任意返回 URL 直接当作已保存图片。
- Gemini 使用 `x-goog-api-key` 和 `/models/{model}:generateContent` 原生协议，识别要求 JSON schema，图片从返回的 inlineData 解析；单品图 1:1，试穿 9:16。模型支持和参数仍待真实验证。
- `backend/app/services/aiyi_video_provider.py`：WaveSpeed 上传、提交、保存远端编号、续查和下载。媒体下载不携带服务 API 密钥，限制来源与大小。
- `backend/app/services/rotation_media.py`：本地视频验证、解码、61 帧抽取及可选绿色背景处理。
- `backend/app/services/aiyi_tasks.py`：用户隔离、任务持久化、阶段更新、单品图确认应用和恢复。

识别请求超时 180 秒，图片请求 600 秒，不自动重试可能计费的图片调用。排队任务重启后继续；已开始但结果不明的图片任务标为 interrupted，用户手动决定重试。已有远端视频编号则续查同一任务，已有视频则继续本地抽帧，不重新提交视频生成；提交后未取得有效编号的任务会标记提交结果不明，并拒绝直接重复提交，需要人工核对服务商记录。

当前执行器面向单进程本地运行，同时处理至多两个任务。公开部署前需要正式认证、数据库迁移和独立 worker。SQLite 的 `create_all` 不替代生产数据库迁移。

## 验证范围

前端 22 项交互测试和类型检查通过，后端完整回归 85 项通过。新增五件套及包的同类替换、人物加五件参考的请求顺序、第六件/重复类别拒绝、裁剪四侧留边和贴边裁剪检查；原有分服务凭据、确认入库、单品图应用、权限、分页及视频恢复检查继续通过。云端服务响应在自动化测试中使用测试替身。

2026-10-16 真人实测采用 [IDM-VTON 人物样例](https://github.com/yisol/IDM-VTON/blob/main/gradio_demo/example/human/00035_00.jpg) 与 [蓝色丝绒商品图](https://github.com/yisol/IDM-VTON/blob/main/gradio_demo/example/cloth/04469_00.jpg)，原图均为 768×1024。网页通过 DeepSeek 识别、确认入库和库内模特选择，随后调用 `gpt-image-2`、quality=high、size=1024x1536。首次收到 HTTP 502（约 94.7 秒）；原任务显式重试一次成功（约 70.9 秒），服务端保存为 1024×1536 JPEG。未生成额外单品图或视频，未核对实际扣费。

结果整体穿着自然，V 领交叠方向、侧系带、短袖和丝绒反光保留；蓝色偏深、下摆上提，构图及面部/裤腰细节有重绘。这是一组真人上衣样例的端到端成功，不是全类别保真验收。真实记录保留在当前账户并带“实测”名称，证据在 `backend/.local/qa/real-photo-tryon-20261016/`。输入样例仅用于内部测试，不作为默认商业素材。

同日五件拼图实测使用用户提供的 819×1211 拼图，DeepSeek 识别出 `polo/jacket/jeans/bag/sneakers`，确认后五件入库。使用内置 imagegen 生成的成年中国女生写实虚拟模特作为上传底图，网页选中五类并提交图片服务，一次调用约 131.6 秒完成。生成图中五件齐全，外套叠穿、手握包柄与裤脚鞋面遮挡自然；包由横向梯形变得更竖、更方，翻盖变大，裤子原有软薄竖皱感减弱，鞋条纹/鞋底改绘。因此只标记为整套穿搭参考通过，不能称为精确商品还原。真实输出、输入、提示词、下载和裁剪修复证据保存在 `backend/.local/qa/collage-chinese-model-20261016/`。图片服务质量仍为 high，未发起视频或额外商品图生成。

浏览器已实际验证模特上传、库内模特跳转试穿预选、本地视频导入 61 帧、滑条定位、左右拖动、自动播放和刷新保留；390 像素宽度无横向溢出或损坏图片。

后续仍需扩大识别样本，检查复杂颜色和纹样、多件试穿、人物脸/体型/姿势、单品图和转身前后细节，并核对耗时和实际费用。此前生产构建已通过，本次浏览器确认入库、上衣筛选、任务恢复及结果下载均通过。
