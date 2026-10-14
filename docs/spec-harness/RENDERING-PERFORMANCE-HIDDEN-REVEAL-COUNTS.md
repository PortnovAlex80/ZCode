# Hidden/reveal work counts（复核 #2 发现 8 · isolated React 证据）

Команда（2026-10-14, node 24.13.1, candidate `8ff180e1` 后工作树）：

```powershell
pnpm exec vitest run packages/ui/test/v4HiddenRevealWorkCounts.measurement.test.ts --silent=false
```

真实 `ConversationTimeline`（极简 DOM + fake virtualizer；插件推导走**真实实现**并计数）。
序列与生产语义一致：先可见消费 8 个 token，随后 16 个 token 在隐藏期到达（rows 持续
更新），reveal 落到最新窗口。三个尺寸全部 3 tests passed：

| 轮数 | 历史 rows | 实际加载 rows | visible（8 token） | hidden（16 token） | reveal |
| ---: | ---: | ---: | --- | --- | --- |
| 200 | 1972 | 1975 | derive 8 / cacheBuilds 8 / materialize 8 / liveTail 8 / turnGroups 8 | derive 0 / cacheBuilds 0 / materialize 0 / liveTail 0 / turnGroups 1 | derive 1 / cacheBuilds 1 / materialize 1 / liveTail 1 / turnGroups 2 |
| 1000 | 10012 | 10015 | 同上（8/8/8/8/8） | 同上（0/0/0/0/1） | 同上（1/1/1/1/2） |
| 2000 | 20055 | 20058 | 同上（8/8/8/8/8） | 同上（0/0/0/0/1） | 同上（1/1/1/1/2） |

判读：

- visible 期逐 token 1 次推导 + 1 次缓存 build + 1 轮物化（流式尾轮）——与纯函数
  配对臂的 streaming-steady 口径一致；
- hidden 期 16 个 token 的**全部**重量级展示工作为 0（唯一计数是隐藏切换那一次
  turn-group 重渲染，不做任何重建）；
- reveal 恰好一次有界重建（1 derive / 1 build / 1 物化 / 1 live-tail），落到隐藏期
  累计的最新窗口——不闪现中间状态；
- 计数与尺寸无关（有界过渡工作，非 O(rows)）。

边界声明：这是 isolated React 计数证据（真实组件、mock DOM/虚拟化器），不是
production renderer 的 wall-clock/FPS/长任务证据——后者仍 live-gated（复核 #2
「Keep pure-function, isolated React and production evidence separate」）。
