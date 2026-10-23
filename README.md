# 爱衣橱（Aiyi Wardrobe）

爱衣橱是一套面向日常穿搭的衣橱管理与虚拟试穿项目。当前主 Demo 根据用户提供的手机录屏重新编写网页界面，适配电脑与手机浏览器。

[打开在线 Demo](https://aiyi-wardrobe-demo.briskthyme.chatgpt.site/) · [代码 MIT 许可](LICENSE)

仓库中有两套界面。`site/` 是本次按视频重构的主 Demo；`app/` 是保留的 Next.js / FastAPI 工作台，仍使用之前的界面与功能入口。运行 `app/` 不会打开新版 Demo。

## 新版 Demo 怎么体验

- 首页展示真人造型，可左右切换；有转身视频时，可以播放、暂停和拖动查看不同角度。
- 拉起人物下方的详情面板，查看本套衣物、颜色和日期，收藏、分享或移除造型。
- 进入衣橱，按上衣、外套、下装、鞋和包的横向分区选择单品；已选衣物进入浮动托盘。
- 展开托盘，点击 `Dress up`，选择全身照片，再提交真人试穿。生成过程中显示任务状态，完成后可以收藏、下载或分享结果。
- 添加衣物时，可以上传图片、调用识别服务、检查识别结果，再确认入库；也可以手动填写资料。
- 菜单中可以切换参考演示与个人衣橱、查看人物照片、填写体验码，以及导出或合并导入备份。

在线识别和真人试穿需要有效体验码，并使用部署端已经配置的模型服务。页面不会把录屏中的示例效果当作本次生成结果。任务断线后可以查询原任务，不会自动再次提交收费请求。

当前的 360 展示通过视频播放和拖动进度实现，并不是可任意观察的 3D 模型。可以给自己的造型导入 MP4、MOV 或 WebM 转身视频；在线 Demo 已接入火山方舟 Seedance 1.0，可从当前全身照生成转身视频。

## 本次重构的范围

新版 `site/` 重写了页面与交互，包括全身人物展示、上拉详情、横向衣物分区、选择飞入托盘、选择人物、生成中页面和试穿结果页。电脑端使用适合大屏的布局，手机端保留录屏中的主要操作顺序。

识别和试穿继续使用原有 `/api/ai/` 后端接口。个人衣物、人物照片、生成记录和备份仍使用原来的浏览器存储名称；已有 OpenWardrobe 风格工作台的分组、平铺布局、穿着记录等扩展数据会随有效备份保留，但新版主 Demo 没有提供这些旧页面的全部操作入口。

录屏参考不能证明所有设备、原 App 的全部页面或全部动效都已逐帧一致。当前网页没有接入 WOO / OpenWardrobe 的账户、社区、内购或专属 AI 服务。

## 直接打开单文件 HTML

下载仓库根目录的 `爱衣橱-暖奶茶网页版.html`，用 Chrome、Edge 或 Safari 打开即可。该文件名为兼容原有分享地址保留，内容使用新版 Demo。

界面、样式、脚本、示例图片与转身片段已经内嵌，无需安装或启动服务。可查看参考造型、整理衣物照片、选择搭配、导入本机转身视频，以及导出备份。通过文件直接打开时不连接 AI 服务，新识别和新试穿请使用在线 Demo 或自己的联网部署。

个人资料保存在当前浏览器。换设备或清理浏览器数据前，请先导出 JSON 备份。JSON 备份包含衣物和人物图片、搭配与生成记录，不包含另行导入的视频文件；视频原件需要单独保留。浏览器不能持久保存资料时，页面会提示当前修改仅暂存。

`爱衣橱-单文件体验版.html` 是保留的早期流程演示，不代表当前主 Demo。

## 目录

- `site/`：新版在线 Demo 源码、识别与试穿接口、任务恢复和额度控制。
- `site/ui/template.html`、`styles.css`：新版页面结构与响应式样式。
- `site/ui/storage.js`：浏览器资料保存、校验、旧数据读取与备份合并。
- `site/ui/api.js`：识别和试穿接口、进度流与任务查询。
- `site/ui/studio.js`：新版人物、衣橱、托盘和试穿流程交互。
- `site/ui/seed.json`、`site/public/video-reference/`：示例资料与参考演示媒体。
- `app/`：保留的本地工作台。Next.js 前端、FastAPI 后端和原有 AI 工作流。
- `html/build.py`：将新版 Site 界面及示例媒体打包为单文件 HTML。
- `docs/`：产品功能与技术方案等历史文档，具体能力以当前运行版本为准。

## 运行新版在线 Demo

需要 Node.js 22：

```sh
cd site
npm ci --no-audit --no-fund
npm run build
npm run start
```

仓库里的 `site/.openai/hosting.json` 只声明通用的 `DB` 和 `BUCKET` 绑定名称，不包含现有部署的项目 ID。正式部署时，需要创建自己的 Cloudflare D1 数据库与 R2 存储，并按 `site/drizzle/` 的迁移初始化数据库。使用 Sites 发布时，由发布流程填写自己的项目标识与资源绑定。

在部署平台配置这些服务端环境变量：

- `AIYI_ACCESS_CODE`：体验入口的访问口令。
- `AIYI_RECOGNITION_KEY`、`AIYI_RECOGNITION_MODEL`：衣物识别服务密钥与模型。
- `AIYI_IMAGE_KEY`、`AIYI_IMAGE_MODEL`：真人试穿服务密钥与模型。
- `AIYI_VIDEO_KEY`、`AIYI_VIDEO_MODEL`：火山方舟视频服务密钥与模型，模型默认 `doubao-seedance-1-0-pro-250528`。

体验者在网页中填写体验码；模型 API 密钥由服务端保管，不要放入 `seed.json`、网页脚本或 Git 仓库。当前 Demo 的个人衣橱保存在浏览器，并不是多设备账户同步服务。

## 运行保留的本地工作台

需要 Node.js 22 和 Python 3.11 或更高版本。首次运行先安装依赖：

```sh
cd app/frontend
npm ci --no-audit --no-fund
cd ../backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-local.lock
```

然后从仓库根目录运行：

```sh
cd app
node scripts/start_local.mjs
```

打开 <http://127.0.0.1:3000> 进入原工作区，也可以双击根目录的 `启动爱衣橱.command`。工作台的“功能与设置”用于配置其本机后端的识别、单品图、试穿和视频服务，与在线 Demo 的服务端环境变量分别管理。

环境变量示例在 `app/.env.example`。Kubernetes 配置请使用 `app/k8s/secrets.yaml.template`，自行填写实际值。

## 修改和重新打包 HTML

新版在线页面和离线 HTML 共用 `site/ui/`。修改模板、样式、`storage.js`、`api.js`、`studio.js` 或示例资料后，在仓库根目录运行：

```sh
python3 html/build.py
```

脚本只读取公开快照中的 UI 和 `site/public/` 下明确引用的示例媒体，重新生成根目录的 `爱衣橱-暖奶茶网页版.html`，无需额外 Python 包。引用的图片和视频会内嵌进文件，因此文件体积会随媒体增加。

## 检查

新版在线 Demo 的资料与接口测试、后端测试和类型检查：

```sh
cd site
node --test tests/video-data.test.mjs tests/video-studio.test.mjs tests/video-rotation-api.test.mjs tests/video-rotation-ui.test.mjs
node --experimental-strip-types --test lib/aiyi/gate.test.ts lib/aiyi/providers.test.ts lib/aiyi/video-provider.test.ts lib/aiyi/video-jobs.test.ts lib/aiyi/video-gate.test.ts
npx tsc --noEmit --incremental false
```

保留工作台的检查：

```sh
cd app/frontend
npx tsc --noEmit --incremental false
npm test -- --run tests/aiyi-ai-workflows.test.tsx tests/aiyi-woo-workflows.test.tsx tests/aiyi-openwardrobe.test.tsx
cd ../backend
.venv/bin/python -m pytest local_tests -q
```

这些检查不会调用收费模型。实际识别、试穿和相机体验还需要在已配置服务与授权设备上验证。

## 来源与许可

本地工作台基于 [Anyesh/wardrowbe](https://github.com/Anyesh/wardrowbe) 的 MIT 许可代码继续开发，原始许可保留在 `app/LICENSE`。爱衣橱自行编写的代码按仓库 [MIT 许可](LICENSE) 发布。

WOO / OpenWardrobe 用于产品流程研究；新版网页依据用户提供的视频参考独立编写。公开仓库不包含它们的反编译程序、下载业务脚本或私有后端实现。

**示例媒体与代码许可分开。** `site/public/video-reference/` 中的图片和短视频来自用户提供录屏的裁剪，仅用于展示参考交互与视觉效果；这些素材也可能被内嵌到单文件 HTML 中。仓库没有取得或授予其中人物、服装、品牌、画面等内容的额外版权或肖像权许可，MIT 代码许可不构成对这些参考媒体的使用授权。它们不能被理解为原创素材或可自由商用的素材；需要独立使用或分发时，请取得相应授权或替换为自有媒体。

## Seedance 转身视频

在线 Demo 的「Create 360°」支持生成 5 秒、720p、固定镜头的转身视频。点击生成前会说明上传与计费；演示素材不会自动调用视频模型。图片中不可见的背面由模型推测，生成视频不等于准确的 3D 扫描，也不保证每次转满一圈。

服务端在首次提交前保存任务记录，接收远端任务 ID 后持续保存；刷新、断线、下载失败时仅查询原任务，不自动重新提交。视频通过带体验码的同源接口取回，服务商密钥及临时媒体地址不会进入前端或备份。结果在服务端保留 7 天，下载的视频保存在当前浏览器。当前演示额度为每浏览器 2 次、全站 6 次，失败尝试也计数；实际费用以服务商账单为准。离线 HTML 无法创建视频任务。
