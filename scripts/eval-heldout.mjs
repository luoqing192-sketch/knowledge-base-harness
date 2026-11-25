import { judgeConclusion } from '../dist/core/distill.js';

// 独立留出集：写的时候没有照着规则调，用来估真实水平
const SET = [
  [true,  '预约单在 15 分钟内未到货会自动取消'],
  [true,  '这个接口返回 401 是因为 token 过期了，要重新换'],
  [true,  '库位标签为空时 ESS 会回落到 warehouseCode'],
  [false, '我觉得应该先重构一下'],
  [false, '要不要加个缓存'],
  [true,  '改成按 orderNo 聚合之后性能从 8s 降到 200ms'],
  [false, '这个方案也许可行吧'],
  [true,  '返仓在 Actor 内直调，没有埋点，插件只能在 http 入口清 SN'],
  [false, '先跑一下看看'],
  [true,  'sonar 门禁阈值配在服务端不在仓库里'],
  [false, '大概是网络抖动'],
  [true,  'JDK 17 才能编译 WES，21 会因为 lombok 失败'],
  [true,  '注意空托清退有三道拦截'],
  [false, '等等我再确认下'],
  [true,  '实测把 redis 的 db 从 0 换成 1 之后快照就正常了'],
  [false, '这个可能跟版本有关系'],
];

let tp = 0, fp = 0, tn = 0, fn = 0;
for (const [want, s] of SET) {
  const got = judgeConclusion(s).accepted;
  const v = want && got ? 'TP' : !want && !got ? 'TN' : want ? 'FN' : 'FP';
  if (v === 'TP') tp++; else if (v === 'FN') fn++; else if (v === 'TN') tn++; else fp++;
  if (v === 'FP' || v === 'FN') console.log(`${v}  ${s}`);
}
const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
console.log(`\nheld-out precision ${(p*100).toFixed(0)}%  recall ${(r*100).toFixed(0)}%  (n=${SET.length}, tp=${tp} fp=${fp} tn=${tn} fn=${fn})`);
