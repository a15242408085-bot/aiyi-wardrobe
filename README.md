# 爱衣橱（Aiyi Wardrobe）

爱衣橱是一套面向女性日常穿搭的衣橱管理与虚拟试穿项目。当前公开版本包含一个可本地运行的完整工作台，以及一个可独立部署的在线体验版。

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
- `爱衣橱-单文件体验版.html`：不需要安装的流程演示页面。
- `docs/`：产品功能与技术方案。

## 本地运行工作台

需要 Node.js 22 和 Python 3.11 或更高版本。

```sh
cd app
node scripts/start_local.mjs
```

然后打开 <http://127.0.0.1:3000>，进入本地工作区。首次安装依赖时可以执行：

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

部署到 Sites 或 Cloudflare 时，在部署平台的环境变量中配置：

- `AIYI_ACCESS_CODE`
- `AIYI_RECOGNITION_KEY`
- `AIYI_RECOGNITION_MODEL`
- `AIYI_IMAGE_KEY`
- `AIYI_IMAGE_MODEL`

请根据服务商条款处理用户上传的照片，并在正式上线前补齐账户系统、隐私政策、数据删除和费用限额。

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
