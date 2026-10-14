# 渲染性能候选：配对测量报告（Wave 3）

- 生成时间：2026-10-14T18:45:47.153Z；node v24.13.1；win32 x64；CPU Intel(R) Core(TM) Ultra 7 155H。
- 候选 revision `8ff180e14ad3d2a5fb581416349cd990dcafc511`（未提交文件 2 个）；seed 20261012；warmup 10；ticks 60；trials 3（A/B 与 B/A 交替）。
- 配对臂都在同一进程/同一 fixture 上运行；等价断言（逐字节 JSON 相等）在计时区外全部通过后才计时。
- 口径：p50/p95 为最近邻秩百分位（与 run-render-baseline.mjs 一致）。helper-only apply / 插件准备 / 完整纯展示准备 / 组合流水线分边界列示。
- 限制：纯函数边界，不含 React/Electron/布局/绘制/交互；fixture 插件实例数为 0（插件臂差异来自 turnOrder 判重路径，与插件卡数量无关）；这是候选证据，不是生产验收。

## 50 轮（历史 511 行，apply 窗口 514 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 0.75x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.01 ms | 0.01 ms | 1.20x |
| apply-24op-uncoalesced-stress | helper-only apply | 0.12 ms | 0.01 ms | 0.12x | 0.19 ms | 0.03 ms | 0.14x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.00 ms | 0.00 ms | 1.02x | 0.01 ms | 0.01 ms | 0.98x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 0.07 ms | 0.01 ms | 0.19x | 0.07 ms | 0.01 ms | 0.20x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 0.05 ms | 0.03 ms | 0.57x | 0.06 ms | 0.03 ms | 0.56x |
| render-units-full-rebuild | complete pure presentation preparation | 0.96 ms | 1.07 ms | 1.11x | 1.23 ms | 1.74 ms | 1.42x |
| render-units-streaming-steady | complete pure presentation preparation | 0.82 ms | 0.09 ms | 0.11x | 1.09 ms | 0.11 ms | 0.10x |
| render-units-late-old-turn | complete pure presentation preparation | 0.68 ms | 0.08 ms | 0.12x | 0.90 ms | 0.17 ms | 0.18x |
| render-units-history-prepend | complete pure presentation preparation | 0.57 ms | 0.13 ms | 0.24x | 0.78 ms | 0.20 ms | 0.26x |
| render-units-truncate-prune | complete pure presentation preparation | 0.60 ms | 0.09 ms | 0.15x | 0.86 ms | 0.14 ms | 0.17x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 0.66 ms | 0.09 ms | 0.14x | 0.98 ms | 0.19 ms | 0.19x |
| timeline-real-chain-streaming<br/>复核 #2 发现 8：真实链路——每 build 新建 resolver 闭包（发现 1 触发形态）；after=推导(现实现)+缓存 build(带 disclosure version) | actual Timeline preparation (derivation -> resolver -> render units) | 0.54 ms | 0.10 ms | 0.19x | 0.81 ms | 0.14 ms | 0.17x |
| highspeed-marked-outputs<br/>终态过期卡片 6 个已标记输出在计时区内（markHighspeedOutputFooterUnits + 发现 5 输出记忆化）；after=暖缓存稳态 | complete pure presentation preparation (Highspeed footer marked) | 0.65 ms | 0.06 ms | 0.10x | 0.83 ms | 0.13 ms | 0.16x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 0.53 ms | 0.58 ms | 1.09x | 0.84 ms | 0.80 ms | 0.94x |

## 200 轮（历史 1972 行，apply 窗口 1975 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 0.67x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.03 ms | 0.03 ms | 1.14x | 0.03 ms | 0.04 ms | 1.09x |
| apply-24op-uncoalesced-stress | helper-only apply | 0.48 ms | 0.04 ms | 0.09x | 0.73 ms | 0.06 ms | 0.08x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.02 ms | 0.02 ms | 0.94x | 0.02 ms | 0.03 ms | 1.38x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 0.14 ms | 0.04 ms | 0.28x | 0.21 ms | 0.05 ms | 0.23x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 0.28 ms | 0.08 ms | 0.27x | 0.40 ms | 0.11 ms | 0.28x |
| render-units-full-rebuild | complete pure presentation preparation | 2.16 ms | 2.72 ms | 1.26x | 3.64 ms | 4.09 ms | 1.12x |
| render-units-streaming-steady | complete pure presentation preparation | 2.54 ms | 0.23 ms | 0.09x | 3.10 ms | 0.38 ms | 0.12x |
| render-units-late-old-turn | complete pure presentation preparation | 2.53 ms | 0.25 ms | 0.10x | 3.19 ms | 0.30 ms | 0.10x |
| render-units-history-prepend | complete pure presentation preparation | 2.50 ms | 0.25 ms | 0.10x | 3.20 ms | 0.36 ms | 0.11x |
| render-units-truncate-prune | complete pure presentation preparation | 2.89 ms | 0.17 ms | 0.06x | 3.90 ms | 0.30 ms | 0.08x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 2.50 ms | 0.34 ms | 0.13x | 3.39 ms | 0.39 ms | 0.11x |
| timeline-real-chain-streaming<br/>复核 #2 发现 8：真实链路——每 build 新建 resolver 闭包（发现 1 触发形态）；after=推导(现实现)+缓存 build(带 disclosure version) | actual Timeline preparation (derivation -> resolver -> render units) | 2.56 ms | 0.34 ms | 0.13x | 3.54 ms | 0.39 ms | 0.11x |
| highspeed-marked-outputs<br/>终态过期卡片 27 个已标记输出在计时区内（markHighspeedOutputFooterUnits + 发现 5 输出记忆化）；after=暖缓存稳态 | complete pure presentation preparation (Highspeed footer marked) | 2.21 ms | 0.22 ms | 0.10x | 3.20 ms | 0.30 ms | 0.10x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 2.27 ms | 2.32 ms | 1.02x | 2.91 ms | 3.14 ms | 1.08x |

## 1000 轮（历史 10012 行，apply 窗口 10015 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.09 ms | 0.09 ms | 1.05x | 0.13 ms | 0.15 ms | 1.14x |
| apply-24op-uncoalesced-stress | helper-only apply | 2.62 ms | 0.20 ms | 0.07x | 3.76 ms | 0.25 ms | 0.07x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.06 ms | 0.09 ms | 1.47x | 0.08 ms | 0.16 ms | 2.02x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 0.39 ms | 0.26 ms | 0.67x | 0.53 ms | 0.36 ms | 0.67x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 9.02 ms | 0.29 ms | 0.03x | 12.40 ms | 0.43 ms | 0.03x |
| render-units-full-rebuild | complete pure presentation preparation | 12.50 ms | 14.66 ms | 1.17x | 15.52 ms | 21.10 ms | 1.36x |
| render-units-streaming-steady | complete pure presentation preparation | 13.57 ms | 1.13 ms | 0.08x | 15.92 ms | 1.50 ms | 0.09x |
| render-units-late-old-turn | complete pure presentation preparation | 12.41 ms | 1.37 ms | 0.11x | 14.74 ms | 1.80 ms | 0.12x |
| render-units-history-prepend | complete pure presentation preparation | 13.10 ms | 1.21 ms | 0.09x | 15.05 ms | 1.65 ms | 0.11x |
| render-units-truncate-prune | complete pure presentation preparation | 12.71 ms | 1.05 ms | 0.08x | 15.19 ms | 1.47 ms | 0.10x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 23.80 ms | 1.78 ms | 0.07x | 26.98 ms | 2.33 ms | 0.09x |
| timeline-real-chain-streaming<br/>复核 #2 发现 8：真实链路——每 build 新建 resolver 闭包（发现 1 触发形态）；after=推导(现实现)+缓存 build(带 disclosure version) | actual Timeline preparation (derivation -> resolver -> render units) | 23.32 ms | 1.38 ms | 0.06x | 28.60 ms | 1.88 ms | 0.07x |
| highspeed-marked-outputs<br/>终态过期卡片 138 个已标记输出在计时区内（markHighspeedOutputFooterUnits + 发现 5 输出记忆化）；after=暖缓存稳态 | complete pure presentation preparation (Highspeed footer marked) | 12.60 ms | 1.25 ms | 0.10x | 14.84 ms | 1.69 ms | 0.11x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 12.49 ms | 13.87 ms | 1.11x | 15.84 ms | 16.23 ms | 1.02x |

## 2000 轮（历史 20055 行，apply 窗口 20058 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.24 ms | 0.38 ms | 1.55x | 0.34 ms | 0.47 ms | 1.36x |
| apply-24op-uncoalesced-stress | helper-only apply | 5.83 ms | 0.61 ms | 0.10x | 8.64 ms | 0.69 ms | 0.08x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.21 ms | 0.34 ms | 1.66x | 0.27 ms | 0.43 ms | 1.59x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 1.73 ms | 0.55 ms | 0.32x | 2.33 ms | 0.72 ms | 0.31x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 94.82 ms | 0.66 ms | 0.01x | 109.72 ms | 0.96 ms | 0.01x |
| render-units-full-rebuild | complete pure presentation preparation | 26.69 ms | 32.25 ms | 1.21x | 31.52 ms | 40.59 ms | 1.29x |
| render-units-streaming-steady | complete pure presentation preparation | 26.97 ms | 2.86 ms | 0.11x | 31.27 ms | 4.00 ms | 0.13x |
| render-units-late-old-turn | complete pure presentation preparation | 27.21 ms | 2.96 ms | 0.11x | 32.00 ms | 3.90 ms | 0.12x |
| render-units-history-prepend | complete pure presentation preparation | 26.40 ms | 3.28 ms | 0.12x | 30.92 ms | 4.26 ms | 0.14x |
| render-units-truncate-prune | complete pure presentation preparation | 25.90 ms | 3.03 ms | 0.12x | 30.82 ms | 4.06 ms | 0.13x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 124.71 ms | 3.69 ms | 0.03x | 151.65 ms | 5.06 ms | 0.03x |
| timeline-real-chain-streaming<br/>复核 #2 发现 8：真实链路——每 build 新建 resolver 闭包（发现 1 触发形态）；after=推导(现实现)+缓存 build(带 disclosure version) | actual Timeline preparation (derivation -> resolver -> render units) | 122.49 ms | 3.68 ms | 0.03x | 142.96 ms | 4.74 ms | 0.03x |
| highspeed-marked-outputs<br/>终态过期卡片 277 个已标记输出在计时区内（markHighspeedOutputFooterUnits + 发现 5 输出记忆化）；after=暖缓存稳态 | complete pure presentation preparation (Highspeed footer marked) | 28.07 ms | 3.66 ms | 0.13x | 31.02 ms | 4.87 ms | 0.16x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 27.88 ms | 25.68 ms | 0.92x | 33.20 ms | 31.47 ms | 0.95x |

## 逐 trial 展开（p50；顺序交替）

| trial | 顺序 |
| --- | --- |
| 50t/apply-empty/0 | before→after |
| 50t/apply-control-only/0 | before→after |
| 50t/apply-1op/0 | before→after |
| 50t/apply-24op-uncoalesced-stress/0 | before→after |
| 50t/apply-24op-post-coalescing/0 | before→after |
| 50t/apply-mixed-distributed/0 | before→after |
| 50t/plugin-derivation/0 | before→after |
| 50t/render-units-full-rebuild/0 | before→after |
| 50t/render-units-streaming-steady/0 | before→after |
| 50t/render-units-late-old-turn/0 | before→after |
| 50t/render-units-history-prepend/0 | before→after |
| 50t/render-units-truncate-prune/0 | before→after |
| 50t/combined-per-frame-pipeline/0 | before→after |
| 50t/timeline-real-chain-streaming/0 | before→after |
| 50t/highspeed-marked-outputs/0 | before→after |
| 50t/noise-full-builder-selfpair/0 | before→after |
| 200t/apply-empty/0 | before→after |
| 200t/apply-control-only/0 | before→after |
| 200t/apply-1op/0 | before→after |
| 200t/apply-24op-uncoalesced-stress/0 | before→after |
| 200t/apply-24op-post-coalescing/0 | before→after |
| 200t/apply-mixed-distributed/0 | before→after |
| 200t/plugin-derivation/0 | before→after |
| 200t/render-units-full-rebuild/0 | before→after |
| 200t/render-units-streaming-steady/0 | before→after |
| 200t/render-units-late-old-turn/0 | before→after |
| 200t/render-units-history-prepend/0 | before→after |
| 200t/render-units-truncate-prune/0 | before→after |
| 200t/combined-per-frame-pipeline/0 | before→after |
| 200t/timeline-real-chain-streaming/0 | before→after |
| 200t/highspeed-marked-outputs/0 | before→after |
| 200t/noise-full-builder-selfpair/0 | before→after |
| 1000t/apply-empty/0 | before→after |
| 1000t/apply-control-only/0 | before→after |
| 1000t/apply-1op/0 | before→after |
| 1000t/apply-24op-uncoalesced-stress/0 | before→after |
| 1000t/apply-24op-post-coalescing/0 | before→after |
| 1000t/apply-mixed-distributed/0 | before→after |
| 1000t/plugin-derivation/0 | before→after |
| 1000t/render-units-full-rebuild/0 | before→after |
| 1000t/render-units-streaming-steady/0 | before→after |
| 1000t/render-units-late-old-turn/0 | before→after |
| 1000t/render-units-history-prepend/0 | before→after |
| 1000t/render-units-truncate-prune/0 | before→after |
| 1000t/combined-per-frame-pipeline/0 | before→after |
| 1000t/timeline-real-chain-streaming/0 | before→after |
| 1000t/highspeed-marked-outputs/0 | before→after |
| 1000t/noise-full-builder-selfpair/0 | before→after |
| 2000t/apply-empty/0 | before→after |
| 2000t/apply-control-only/0 | before→after |
| 2000t/apply-1op/0 | before→after |
| 2000t/apply-24op-uncoalesced-stress/0 | before→after |
| 2000t/apply-24op-post-coalescing/0 | before→after |
| 2000t/apply-mixed-distributed/0 | before→after |
| 2000t/plugin-derivation/0 | before→after |
| 2000t/render-units-full-rebuild/0 | before→after |
| 2000t/render-units-streaming-steady/0 | before→after |
| 2000t/render-units-late-old-turn/0 | before→after |
| 2000t/render-units-history-prepend/0 | before→after |
| 2000t/render-units-truncate-prune/0 | before→after |
| 2000t/combined-per-frame-pipeline/0 | before→after |
| 2000t/timeline-real-chain-streaming/0 | before→after |
| 2000t/highspeed-marked-outputs/0 | before→after |
| 2000t/noise-full-builder-selfpair/0 | before→after |

## 完整 store 边界（复核 #2 发现 8；候选绝对值，非配对臂）

真实 ConversationProjectionStore（fake transport + 直驱 handleFrame）：冷订阅 → 快照帧 → 逐帧投递 1-op row.delta 逻辑帧（累积流式，seq 连续）。计时覆盖 store 的完整帧路径（applyConversationFrame + shareDeltaRows 共享扫描 + 发布）；连接/快照 setup 在计时区外。同树内不存在改造前 store 实现，此边界为候选绝对成本；before/after 归因见 helper-only apply 配对臂。

| 轮数 | store 已加载 rows | 帧 p50 | 帧 p95 | 帧 min | 帧 max |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50 | 514 | 0.02 ms | 0.05 ms | 0.02 ms | 0.08 ms |
| 200 | 1975 | 0.09 ms | 0.12 ms | 0.07 ms | 0.15 ms |
| 1000 | 10015 | 0.38 ms | 0.58 ms | 0.34 ms | 0.63 ms |
| 2000 | 20058 | 1.00 ms | 1.31 ms | 0.74 ms | 1.43 ms |

详细逐 trial p50/p95 与 spread 见同目录 JSON（报告文件旁 `.json` 后缀）。
