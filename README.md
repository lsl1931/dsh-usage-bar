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

- 用量折叠语义与 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` projection 完全一致；
- 缓存命中率沿用官方公式（见 `dsh-client-ui-chat` 的 `cacheHitPercent`）：

  ```
  cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)
  ```

统计口径与官方一致：`assistant/chunk` 的 usage 是早期样本，`assistant/message` 的 usage 会**替换**同一 attempt 的早期样本；`llm/retry-started` 会关闭该替换槽，使重试后的用量**累加**。

历史数据**不自己扫盘**：通过 `ctx.sessionPersistence`（`list` / `open(id, "read")` / `read`）读取。这样由宿主负责：

- 解析 harness home（配置 > `$DSH_HOME` > `~/.dsh`）；
- 项目目录布局与 session id 编码；
- 选择**当前代次**的日志（`session.v{N}.jsonl.zstd` 取最高 N），必要时做 v2→v3 迁移；
- 多帧 zstd 解码。

### 计数模型：按会话重算，再求和

每个会话在账本里有一条**独立条目**，它是该会话事件日志的纯函数；所有展示数字都是这些条目的求和。因此重复观察同一会话不会改变任何数字——这正是让实时采集与历史回填彼此幂等、且跨重启幂等的原因。

「本次统计」是相对上次清零的**区间视图**（条目的 `floor` 记录清零前的部分），而不是一个累加器；所以重启无法把历史重放回已清零的区间。

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
node selftest.mjs                  # 折叠语义 + 真实日志解码
node selftest-daily.mjs            # 同日替换 / 跨零点修正 / 重试累加 / 逐日命中率
node selftest-reset.mjs            # 清零语义 + 路由契约（驱动真实 handler）
node selftest-sumdaily.mjs         # 逐日汇总 == 总计
node selftest-migrate.mjs          # 真实日志摄取 + 第二趟幂等
node selftest-rail.mjs             # 侧边栏收起态渲染、CSS 约束、样式归属、主题 token
node selftest-idempotence.mjs      # 实时/回填/重启/中断重试的幂等不变量
node selftest-integration.mjs      # 经真实 apply() 的端到端：回填 → 实时 → 清零
node selftest-ledger-invariants.mjs # 账本不变量（sum(daily)==totals、会话互不串味）
node selftest-persist.mjs          # 写盘失败不致命且会上报一次
node selftest-store-size.mjs       # 账本体积与真实用量成正比
node selftest-spec-claims.mjs      # 代码规范里的契约与实现一致（可执行规范）
```

依赖本机会话日志的自检（`selftest.mjs` 的真实日志段、`selftest-migrate.mjs`、`selftest-integration.mjs`）在找不到会话日志时会**跳过**而不是失败，路径取自 `$DSH_HOME`，无硬编码。

## 性能

账本采用「按会话重算、再求和」：每个会话一条条目，是该会话事件日志的纯函数。
实时路径每次事件只做增量折叠，条目直接**共享**日桶 map（不深拷贝），因此单事件成本
不随会话天数增长。实测（本机）：

| 场景 | 事件数 | 总耗时 | 单事件 |
|---|---|---|---|
| 典型会话（2 天） | 100 | 0.4ms | 3.9us |
| 长历史（200 天） | 10,000 | 4.3ms | 0.4us |
| 极端（365 天 × 100） | 36,500 | 10.9ms | 0.3us |

会话首次被观察（如 resume）需要一次全量折叠：200 天约 1.9ms，36,500 事件约 8.5ms。
历史回填按会话逐个 await，不会长时间占用事件循环。

## 已知边界

- 日历仅覆盖**会话日志里实际出现过的日期**。
- 热力图分档是相对历史峰值的相对值，因此翻页时同一档位的颜色保持一致。
- 历史摄取依赖 `ctx.sessionPersistence`；该服务缺失时只显示实时用量，不报错。

## 许可

MIT