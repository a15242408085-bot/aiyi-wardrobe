# 爱衣橱在线体验版

现有 Sites 项目升级为同源网页与 API。线上网址保留不变。

## 2026-10-24 素材与视频适配

首页与人物选择使用 6 张独立生成的成年女性虚拟模特透明 PNG，衣橱的「精选素材」提供上衣类、裤子、鞋子各 10 张透明 PNG（开衫和拉链卫衣归入外套分区）。这些素材可用于真实试穿请求；预置模特穿搭不是所选单品的实时试穿结果。原有个人图片、衣物和生成记录保留。

素材位于 `public/model-assets/` 与 `public/wardrobe-assets/`，来源、原始尺寸和校验值见各目录的 `manifest.json`。保留生成器原始 PNG 与透明通道，页面按需加载图片。

视频服务通过后端 `AIYI_VIDEO_KEY` 和 `AIYI_VIDEO_MODEL` 配置。默认仍为 `doubao-seedance-1-0-pro-250528`，也支持 Seedance 2.0 标准版 `doubao-seedance-2-0-260128` 的参数格式。2.0 请求关闭音频，用提示词固定机位，不传仅适用于 1.0 的 `camera_fixed`；页面显示实际配置的模型标签。切换模型必须同时确认账号已开通相应能力。

Seedance 2.0 对写实人像有独立输入要求。普通上传的人脸照片或其他平台生成的写实人像可能被拒绝；应使用平台支持的可信人像输入方式。当前兼容参数测试不代表 2.0 已真实生成成功。[官方肖像素材说明](https://docs.volcengine.com/docs/ark/seedance-portrait-asset-guide?lang=zh)

360 视频仍为 5 秒、720p。服务器先保存任务记录再提交，断线后查询原任务，不自动重发收费请求。每浏览器 2 次、全站 6 次的视频试用额度与其他生成任务共用单个并发位置；失败请求也计次数。服务器结果保留 7 天，取回的视频存入本机浏览器。

## 2026-10-21 交互更新

界面参考 WOO 的公开截图和安装包中确认的页面流程，重新实现为网页：人物造型首页、可展开详情、分类衣物货架、选衣托盘、试穿入口、全身照指导、浏览器拍摄、造型日历、收藏与分享下载。没有复制 WOO 的代码、人物素材或服务器能力。

在线识别与试穿仍使用现有接口。新保存的试穿按日期出现在首页与日历；人物静态图会明确标注，导入转身视频后才能拖动旋转。导入的视频保存在浏览器 IndexedDB 中，绑定导入时的造型；视频不随 JSON 备份导出。相机只在用户主动点击拍摄时请求权限，拍摄后仍需确认照片和点击识别才发送到 AI 服务。

参考：[WOO 官方 App Store 页面](https://apps.apple.com/us/app/id6804240807)。原生窗口自动化本轮连接超时，因此未将所有页面标记为运行实测，也没有新增未配置的会员付费入口。



- `ui/`：页面、样式和浏览器逻辑；`npm run build` 先生成 `app/experience.html`。
- `app/route.ts`：返回完整体验页面。
- `app/api/ai/[...path]/route.ts`：口令验证、识别、试穿及任务查询。
- `lib/aiyi/providers.ts`：固定目的地的 DeepSeek 识别和 GPT 图片适配器。
- `lib/aiyi/gate.ts`：任务归属、原子额度、幂等保护与过期清理。
- `db/schema.ts`、`drizzle/`：D1 任务表和迁移；R2 私有保存任务结果。

服务端环境变量通过 Sites 的环境变量工具配置：`AIYI_ACCESS_CODE`、`AIYI_RECOGNITION_KEY`、`AIYI_RECOGNITION_MODEL`、`AIYI_IMAGE_KEY`、`AIYI_IMAGE_MODEL`。不要把值写进源码、HTML 或部署包。

当前试用额度为本站累计 30 次识别、12 次试穿，每个浏览器累计 8 次识别、3 次试穿，全站同时处理 1 个生成任务。失败但已向服务商发起的任务仍计数；自动重试可能重复收费，因此查询只读，不自动重新生成。此设置为暂时体验服务，不是完整账户系统。

衣橱和试穿历史在浏览器保存，使用原 JSON 备份格式并向后兼容。只有点击 AI 操作才上传对应图片。服务器结果可查询 7 天，过期数据在后续鉴权请求或任务结束时清理；不保证无人访问时的定时物理删除。生成期间请保持页面和网络连接。

```sh
node --experimental-strip-types --test lib/aiyi/gate.test.ts lib/aiyi/providers.test.ts
npx tsc --noEmit --incremental false
```

部署使用 Sites 技能的构建、源码同步、归档和发布流程。保留 `sites()` 构建插件及当前 `.openai/hosting.json` 的项目标识、D1/R2 绑定。发布会应用生产迁移，本地迁移不要重复执行。

---

以下是运行环境的原始说明，供后续维护参考。

# vinext-starter

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
