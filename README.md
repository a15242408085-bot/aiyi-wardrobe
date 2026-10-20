# 爱衣橱（Aiyi Wardrobe）

爱衣橱是一套面向日常穿搭的衣橱管理与虚拟试穿项目。当前公开版本包含本地完整工作台、可部署的在线版源码，以及无需安装的单文件 HTML 网页。

## 先打开 HTML 体验

下载仓库中的 `爱衣橱-暖奶茶网页版.html`，用 Chrome、Edge 或 Safari 打开即可使用。图片、样式和脚本已内嵌，无需启动服务。

支持添加衣物照片、分类、搜索、收藏、编辑、保存搭配、导入转身视频和导出备份。新增内容保存在当前浏览器，换设备前请先导出备份。试穿区域提供已经生成的示例；这个 HTML 文件不连接 AI 服务，不会为新搭配生成试穿图。

## 本次交互更新

新增 WOO 风格的造型展示首页、可展开详情、衣物货架、浮动选衣托盘、穿搭日历、全身照指导和浏览器拍摄。现有识别、试穿、单品图和本地 360 接口继续使用。网页实现与示例素材由爱衣橱独立提供，未包含 WOO 反编译代码或人物资源。

在线版导入的视频可以在当前浏览器恢复；JSON 备份不包含视频。离线 HTML 不连接 AI 服务，新试穿请使用联网部署。

## 当前能力

- 衣物照片上传、分类、搜索、收藏和编辑
- 用识别服务提取衣物类别、颜色和细节，确认后保存到衣橱
- 生成干净的单品展示图
- 保存真人模特照片，选择多件衣物生成试穿效果
- 上传或导入转身视频，拖动查看 360 展示
- 暖奶茶色的工作台布局，模特旋转区、衣物选择区和试穿结果区
- 独立的服务设置页，密钥只在本机后端保存，不写进浏览器

## 目录

- `app/`：本地工作台。Next.js 前端、FastAPI 后端、SQLite 本地数据和 AI 工作流。
- `site/`：在线体验版源码。包含识别、试穿任务接口、额度控制和前端页面。
- `html/`：单文件网页打包脚本，界面直接复用 `site/ui/`。
- `爱衣橱-暖奶茶网页版.html`：当前暖奶茶版，可直接打开、离线使用和转发。
- `爱衣橱-单文件体验版.html`：不需要安装的流程演示页面。
- `docs/`：产品功能与技术方案。

## 本地运行工作台

需要 Node.js 22 和 Python 3.11 或更高版本。

```sh
cd app
node scripts/start_local.mjs
```

然后打开 <http://127.0.0.1:3000>，进入本地工作区。首次安装依赖时请先执行：

```sh
cd app/frontend
npm ci --no-audit --no-fund
cd ../backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-local.lock
```

也可以双击项目根目录的 `启动爱衣橱.command`。

## 配置 AI 服务

在工作台的“功能与设置”里分别配置衣物识别、单品图与试穿、360 视频服务。密钥只通过本地后端使用，不要把真实密钥写入代码或提交到 Git。

环境变量示例在 `app/.env.example`。Kubernetes 部署请复制 `app/k8s/secrets.yaml.template`，自行填写值；公开仓库不会包含任何真实密钥或本地数据。

## 运行在线体验版

在线体验版需要 Node.js 22：

```sh
cd site
npm ci --no-audit --no-fund
npm run build
npm run start
```

仓库里的 `site/.openai/hosting.json` 只声明通用的 `DB` 和 `BUCKET` 绑定名称，不包含现有部署的项目 ID。开发服务使用本地存储；正式部署时需要创建自己的 Cloudflare D1 数据库与 R2 存储，并按 `site/drizzle/` 的迁移初始化数据库。使用 Sites 发布时，由发布流程填写你自己的项目标识和实际资源绑定。

部署到 Sites 或 Cloudflare 时，在部署平台的环境变量中配置：

- `AIYI_ACCESS_CODE`：体验入口的访问口令。
- `AIYI_RECOGNITION_KEY`：衣物识别服务密钥。
- `AIYI_RECOGNITION_MODEL`：识别模型名称。
- `AIYI_IMAGE_KEY`：试穿图生成服务密钥。
- `AIYI_IMAGE_MODEL`：图片模型名称。

请根据服务商条款处理用户上传的照片，并在正式上线前补齐账户系统、隐私政策、数据删除和费用限额。

## 修改和重新打包 HTML

界面和交互共用 `site/ui/template.html`、`site/ui/styles.css` 和 `site/ui/app.js`。修改后，在仓库根目录运行：

```sh
python3 html/build.py
```

脚本使用仓库内的示例资源，重新生成根目录的 `爱衣橱-暖奶茶网页版.html`，不需要安装额外 Python 包。

## 检查

```sh
cd app/frontend
npx tsc --noEmit --incremental false
npm test -- --run tests/aiyi-ai-workflows.test.tsx tests/aiyi-woo-workflows.test.tsx
cd ../backend
.venv/bin/python -m pytest local_tests -q
```

在线体验版的类型检查和单元测试：

```sh
cd site
node --experimental-strip-types --test lib/aiyi/gate.test.ts lib/aiyi/providers.test.ts
npx tsc --noEmit --incremental false
```

## 来源与许可

本项目的本地工作台基于 [Anyesh/wardrowbe](https://github.com/Anyesh/wardrowbe) 的 MIT 许可代码继续开发，原始许可文本保留在 `app/LICENSE`。爱衣橱新增的工作流、中文界面和在线体验版代码按本仓库的 MIT 许可发布。

WOO/REA 只作为产品流程研究参考，公开仓库不包含其反编译代码、资源或私有实现。
