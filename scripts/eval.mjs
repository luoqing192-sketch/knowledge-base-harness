import { judgeConclusion } from '../dist/core/distill.js';

// 人工标注：true = 这条确实该进 wiki（已定论），false = 不该进
const SET = [
  [true,  '确认了：本地启动 WES 必须设置 MOCK_ESS=on，否则连不上 ESS'],
  [false, '这里必须注意一下安全问题，别乱改'],
  [true,  '实测把 ttl 设为 0 之后 cache.log 不再报错'],
  [true,  '把 jdk 换成 21 就好了'],
  [false, '这个不能删'],
  [true,  '那个报错是端口没开'],
  [false, '大概在第 3 步会失败'],
  [true,  '返仓入参必须回传 SN，否则 ESS 拒单 (commit 4e871a50bb)'],
  [false, '我们也许应该重构一下这块代码'],
  [true,  '订单箱状态机是 PICKING→SEALED/HANG_UP/CANCELED 三态'],
  [true,  '日志里报 429 说明信号量是负数'],
  [false, '我刚才跑了测试'],
];

let tp = 0, fp = 0, tn = 0, fn = 0;
for (const [want, s] of SET) {
  const got = judgeConclusion(s).accepted;
  const verdict = want && got ? 'TP' : !want && !got ? 'TN' : want ? 'FN' : 'FP';
  if (verdict === 'TP') tp++; else if (verdict === 'FN') fn++;
  else if (verdict === 'TN') tn++; else fp++;
  console.log(`${verdict}  ${s}`);
}
const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
console.log(`\nprecision ${(p*100).toFixed(0)}%  recall ${(r*100).toFixed(0)}%   (n=${SET.length})`);
