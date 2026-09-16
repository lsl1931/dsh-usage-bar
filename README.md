# dsh-usage-bar

在 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）Web 版**左侧边栏「设置」按钮上方**常驻显示总 token 消耗与缓存命中率，点击可展开日历式热力图查看每天的用量。

## 功能

- **常驻用量条**：显示 `Σ <总量> tokens · 缓存命中 <百分比>%`，数据每 2 秒轮询一次（首屏后降为 10 秒）。
- **清零**：只清空「本次统计」的显示并从零重新累计，**不影响历史累计与日历数据**（重启也不会把历史重放回新统计）。
- **日历热力图**：每页 30 天，`‹ ›` 翻页；每天一格，按当日用量相对**历史峰值**分 4 档，颜色由浅到深；点击某天查看该日用量与命中率明细。
- **历史累计页签**：显示不受清零影响的全部历史总量、命中率与四项分类（未缓存输入 / 缓存读 / 缓存写 / 输出）。
- **侧边栏收起时自适应**：收起为窄轨道时只显示紧凑总量，面板从轨道右侧弹出，保证完整可读。

## 数据来源

全部取自 dsh 官方数据，不自行估算：

- 用量来自 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` projection；
- 缓存命中率沿用官方公式（见 `dsh-client-ui-chat` 的 `cacheHitPercent`）：

  ```
  cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)
  ```

统计口径与官方一致：`assistant/chunk` 的 usage 是早期样本，`assistant/message` 的 usage 会**替换**同一 attempt 的早期样本；`llm/retry-started` 会关闭该替换槽，使重试后的用量**累加**。

历史数据通过读取本机 `$DSH_HOME/sessions/**/session.jsonl.zstd` 回填（用 `node:zlib` 的 zstd 支持，无额外依赖）。

## 安装

```bash
dsh plugin --profile web add dsh-usage-bar
```

或在本仓库目录开发时，用 `link:` 让改动即时生效：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:<本仓库绝对路径>"
```

随后在 `dsh.profile.bundles` 中列出 `dsh-usage-bar`，重启 `dsh web` 即可。

> 开发提示：用 `link:` 而非 `file:`。`file:` 会做快照拷贝，改完源码后 host 端可能仍加载旧版本，表现为面板空白或路由 404。

## 开发

零构建依赖，仅需 Node.js ≥ 22：

```bash
node build.mjs     # 由 src/ 生成 lib/
```

- `src/index.js` → `lib/index.js`（Node half，原样拷贝）
- `src/client/index.js` → `lib/client.js`（包成 `window.__ModuleLoader__` 的 factory 形式）

**只改 client half 时**，浏览器硬刷新（Ctrl+Shift+R）即可生效；改 Node half 需要重启 `dsh web`。

## 自检

```bash
node selftest.mjs           # 折叠语义 + 真实日志解码
node selftest-daily.mjs     # 同日替换 / 跨零点修正 / 重试累加 / 逐日命中率
node selftest-reset.mjs     # 清零的 nonce 校验与归零行为
node selftest-sumdaily.mjs  # 逐日汇总 == 总计
node selftest-migrate.mjs   # 历史数据一次性迁移进日历
node selftest-rail.mjs      # 侧边栏收起态的渲染与 CSS 约束
```

依赖本机会话日志的两个自检（`selftest.mjs` 的真实日志段、`selftest-migrate.mjs`）在找不到 `$DSH_HOME/sessions` 时会**跳过**而不是失败，路径取自环境变量，无硬编码。

## 已知边界

- 日历仅覆盖**会话日志里实际出现过的日期**。
- 热力图分档是相对历史峰值的相对值，因此翻页时同一档位的颜色保持一致。

## 许可

MIT
