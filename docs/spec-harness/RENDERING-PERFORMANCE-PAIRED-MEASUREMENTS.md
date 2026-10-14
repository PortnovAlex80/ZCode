# 渲染性能候选：配对测量报告（Wave 3）

- 生成时间：2026-10-14T15:14:18.744Z；node v24.13.1；win32 x64；CPU Intel(R) Core(TM) Ultra 7 155H。
- 候选 revision `2e52f34197dc8581b5f7c5eba1e7cb46462e60fb`（未提交文件 3 个）；seed 20261012；warmup 10；ticks 60；trials 3（A/B 与 B/A 交替）。
- 配对臂都在同一进程/同一 fixture 上运行；等价断言（逐字节 JSON 相等）在计时区外全部通过后才计时。
- 口径：p50/p95 为最近邻秩百分位（与 run-render-baseline.mjs 一致）。helper-only apply / 插件准备 / 完整纯展示准备 / 组合流水线分边界列示。
- 限制：纯函数边界，不含 React/Electron/布局/绘制/交互；fixture 插件实例数为 0（插件臂差异来自 turnOrder 判重路径，与插件卡数量无关）；这是候选证据，不是生产验收。

## 200 轮（历史 1972 行，apply 窗口 1975 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 0.83x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.25x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.03 ms | 0.03 ms | 1.19x | 0.03 ms | 0.03 ms | 1.02x |
| apply-24op-uncoalesced-stress | helper-only apply | 0.53 ms | 0.04 ms | 0.08x | 0.80 ms | 0.05 ms | 0.06x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.02 ms | 0.02 ms | 1.01x | 0.02 ms | 0.02 ms | 1.04x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 0.14 ms | 0.04 ms | 0.30x | 0.20 ms | 0.05 ms | 0.24x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 0.29 ms | 0.07 ms | 0.24x | 0.42 ms | 0.10 ms | 0.23x |
| render-units-full-rebuild | complete pure presentation preparation | 2.93 ms | 2.91 ms | 0.99x | 4.27 ms | 4.31 ms | 1.01x |
| render-units-streaming-steady | complete pure presentation preparation | 2.15 ms | 0.15 ms | 0.07x | 3.11 ms | 0.26 ms | 0.08x |
| render-units-late-old-turn | complete pure presentation preparation | 2.36 ms | 0.14 ms | 0.06x | 3.21 ms | 0.26 ms | 0.08x |
| render-units-history-prepend | complete pure presentation preparation | 2.13 ms | 0.15 ms | 0.07x | 3.10 ms | 0.22 ms | 0.07x |
| render-units-truncate-prune | complete pure presentation preparation | 1.96 ms | 0.11 ms | 0.06x | 2.87 ms | 0.19 ms | 0.06x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 2.53 ms | 0.19 ms | 0.07x | 3.60 ms | 0.32 ms | 0.09x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 2.18 ms | 2.14 ms | 0.98x | 3.07 ms | 3.09 ms | 1.01x |

## 1000 轮（历史 10012 行，apply 窗口 10015 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.09 ms | 0.08 ms | 0.99x | 0.13 ms | 0.11 ms | 0.84x |
| apply-24op-uncoalesced-stress | helper-only apply | 2.33 ms | 0.21 ms | 0.09x | 3.65 ms | 0.28 ms | 0.08x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.09 ms | 0.09 ms | 0.98x | 0.15 ms | 0.13 ms | 0.86x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 0.81 ms | 0.27 ms | 0.34x | 1.10 ms | 0.33 ms | 0.30x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 6.79 ms | 0.30 ms | 0.04x | 9.58 ms | 0.44 ms | 0.05x |
| render-units-full-rebuild | complete pure presentation preparation | 12.45 ms | 12.59 ms | 1.01x | 16.58 ms | 20.19 ms | 1.22x |
| render-units-streaming-steady | complete pure presentation preparation | 11.95 ms | 0.91 ms | 0.08x | 14.06 ms | 1.32 ms | 0.09x |
| render-units-late-old-turn | complete pure presentation preparation | 13.63 ms | 0.92 ms | 0.07x | 18.35 ms | 1.72 ms | 0.09x |
| render-units-history-prepend | complete pure presentation preparation | 12.02 ms | 0.86 ms | 0.07x | 17.19 ms | 1.21 ms | 0.07x |
| render-units-truncate-prune | complete pure presentation preparation | 13.32 ms | 1.04 ms | 0.08x | 19.25 ms | 1.71 ms | 0.09x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 21.59 ms | 1.32 ms | 0.06x | 31.91 ms | 2.35 ms | 0.07x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 13.90 ms | 12.75 ms | 0.92x | 18.10 ms | 16.39 ms | 0.91x |

## 2000 轮（历史 20055 行，apply 窗口 20058 行；24-op 压力帧合并后 1 op）

| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| apply-empty | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-control-only | helper-only apply | 0.00 ms | 0.00 ms | 1.00x | 0.00 ms | 0.00 ms | 1.00x |
| apply-1op<br/>两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms） | helper-only apply | 0.28 ms | 0.45 ms | 1.63x | 0.43 ms | 0.49 ms | 1.13x |
| apply-24op-uncoalesced-stress | helper-only apply | 6.98 ms | 0.63 ms | 0.09x | 12.57 ms | 0.85 ms | 0.07x |
| apply-24op-post-coalescing<br/>1 op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算 | helper-only apply | 0.22 ms | 0.45 ms | 2.02x | 0.32 ms | 0.54 ms | 1.67x |
| apply-mixed-distributed<br/>8 行分布 row.delta + 1 control | helper-only apply | 1.63 ms | 0.64 ms | 0.39x | 2.26 ms | 0.88 ms | 0.39x |
| plugin-derivation<br/>fixture 插件实例数为 0（与审计一致） | plugin preparation | 99.09 ms | 0.61 ms | 0.01x | 120.45 ms | 0.98 ms | 0.01x |
| render-units-full-rebuild | complete pure presentation preparation | 25.71 ms | 29.45 ms | 1.15x | 31.34 ms | 36.53 ms | 1.17x |
| render-units-streaming-steady | complete pure presentation preparation | 23.45 ms | 2.10 ms | 0.09x | 26.39 ms | 3.18 ms | 0.12x |
| render-units-late-old-turn | complete pure presentation preparation | 23.54 ms | 2.17 ms | 0.09x | 26.97 ms | 3.44 ms | 0.13x |
| render-units-history-prepend | complete pure presentation preparation | 25.19 ms | 1.90 ms | 0.08x | 28.35 ms | 2.77 ms | 0.10x |
| render-units-truncate-prune | complete pure presentation preparation | 25.40 ms | 2.13 ms | 0.08x | 30.08 ms | 3.21 ms | 0.11x |
| combined-per-frame-pipeline | combined per-frame pure pipeline (apply + plugin + render units) | 120.37 ms | 2.73 ms | 0.02x | 139.04 ms | 3.97 ms | 0.03x |
| noise-full-builder-selfpair | noise reference (baseline/baseline) | 25.22 ms | 25.18 ms | 1.00x | 29.97 ms | 32.00 ms | 1.07x |

## 逐 trial 展开（p50；顺序交替）

| trial | 顺序 |
| --- | --- |
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
| 2000t/noise-full-builder-selfpair/0 | before→after |

详细逐 trial p50/p95 与 spread 见同目录 JSON（报告文件旁 `.json` 后缀）。
