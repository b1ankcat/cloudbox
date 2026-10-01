# cloudbox

cloudbox 可以自动探测 github 上最近更新的 tvbox 源，并且生成所有可访问源的合并 json。

第一次访问 `/config.json` 时，Worker 会探测内置地址并把合并结果写入 KV；之后由 Cron Trigger 每天自动更新。

Cloudflare 部署时不会执行 Worker 代码。因此首次部署完成后，需要访问一次 `/config.json` 来初始化 KV。首次请求只探测内置的 6 个地址，定时任务还会搜索 GitHub 仓库。

## 部署

创建 KV namespace：

```powershell
pnpm exec wrangler kv namespace create TVBOX_RESULTS
```

将命令输出的 namespace ID 填入 `wrangler.jsonc` 的 `id`，并启用远程 KV：

```jsonc
"kv_namespaces": [
  {
    "binding": "TVBOX_RESULTS",
    "id": "你的 KV namespace ID",
    "remote": true
  }
]
```

安装依赖并部署：

```powershell
pnpm install
pnpm run deploy
```

部署后访问：

```text
https://<你的 Worker 域名>/config.json
```

## 本地开发

启动本地 Worker：

```powershell
pnpm run dev
```

访问 `http://localhost:8787/config.json` 触发首次初始化；访问 `http://localhost:8787/__scheduled` 手动触发定时任务。`/discovered.json` 返回最近一次探测报告，`/healthz` 返回健康状态。

只检查打包结果、不部署：

```powershell
pnpm run dry-run
```

Cron 使用 UTC。当前配置 `0 16 * * *` 对应香港时间每天 00:00。
