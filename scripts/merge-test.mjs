/* Node 自测：用 esbuild 即时编译引擎后跑断言。不进生产构建。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

mkdirSync('/tmp/merge-test', { recursive: true });
execFileSync('/workspace/node_modules/.bin/esbuild', [
  'src/merge/engine.ts',
  '--bundle', '--format=esm', '--platform=node',
  '--outfile=/tmp/merge-test/engine.mjs'
], { cwd: '/workspace', stdio: 'inherit' });

const { buildPackage, prepareMerge, applyMerge, setConflictResolution, rollbackState } =
  await import(pathToFileURL('/tmp/merge-test/engine.mjs').href);

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else { passed += 1; console.log('✓ ' + msg); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const makeState = () => ({
  revision: 10,
  updatedAt: '2026-09-01T00:00:00.000Z',
  activeTranscriptId: 'tr-local',
  activeSegmentId: 's1',
  activeThemeId: 'ta',
  coderA: '林',
  coderB: '赵',
  transcripts: [{ id: 'tr-local', title: '王梅访谈', participant: '王梅', importedAt: '', sourceName: 'WM-01.mp3' }],
  segments: [
    { id: 's1', transcriptId: 'tr-local', order: 0, speaker: '王梅', time: '00:01', text: '我在镇上读书，母亲主张转学。', assignments: { A: ['ta'], B: ['ta'] }, note: '' },
    { id: 's2', transcriptId: 'tr-local', order: 1, speaker: '访谈者', time: '00:02', text: '哪位老师影响最大？', assignments: { A: [], B: [] }, note: '' },
    { id: 's3', transcriptId: 'tr-local', order: 2, speaker: '王梅', time: '00:03', text: '周老师拿旧地图讲课。', assignments: { A: ['tb'], B: ['tb'] }, note: '本地备注' }
  ],
  themes: [
    { id: 'ta', name: '教育经历', parentId: null, color: '', definition: '本地定义', memo: '', examples: [] },
    { id: 'tb', name: '教师影响', parentId: 'ta', color: '', definition: '', memo: '', examples: [] },
    { id: 'tc', name: '家庭支持', parentId: null, color: '', definition: '', memo: '', examples: [] }
  ],
  audit: []
});

// 把一份库的所有 id 换发（模拟离线机器从一开始就处于不同 id 空间）
const reId = (state) => {
  const copy = structuredClone(state);
  const segMap = { s1: 'X1', s2: 'X2', s3: 'X3' };
  const themeMap = { ta: 'ZA', tb: 'ZB', tc: 'ZC' };
  const trMap = { 'tr-local': 'TR9' };
  copy.segments.forEach((s) => { s.id = segMap[s.id] ?? s.id; s.transcriptId = trMap[s.transcriptId] ?? s.transcriptId; });
  copy.themes.forEach((t) => { t.id = themeMap[t.id] ?? t.id; t.parentId = t.parentId ? themeMap[t.parentId] ?? t.parentId : null; });
  copy.transcripts.forEach((t) => { t.id = trMap[t.id] ?? t.id; });
  copy.activeTranscriptId = 'TR9';
  copy.activeSegmentId = 'X1';
  copy.activeThemeId = 'ZA';
  return copy;
};

// ---- 场景 1：两端编号全不同；同编码员改同项且不同 → 冲突；跨编码员列互不影响 ----
{
  const ancestor = makeState();
  const offlineAncestor = reId(ancestor);
  const local0 = structuredClone(ancestor);
  const pkg0 = buildPackage(offlineAncestor, 'B');
  const remote = structuredClone(pkg0.state);

  remote.segments.find((s) => s.id === 'X2').assignments.B = ['ZB'];          // 离线 B 给 X2 加教师影响
  local0.segments.find((s) => s.id === 's3').assignments.B = ['tc'];          // 本地 B 把 s3 改家庭支持
  remote.segments.find((s) => s.id === 'X3').assignments.B = ['ZA'];          // 离线 B 把 X3 改教育经历 → 冲突
  remote.segments.find((s) => s.id === 'X1').assignments.A = ['ZC'];          // 离线端动 A 列，不应影响本地
  const offlinePack = { ...pkg0, state: remote };

  const plan = prepareMerge(local0, offlinePack);
  ok(plan.segmentMappings.every((m) => m.kind === 'fingerprint'), '场景1: 编号全不同仍按来源+指纹精确对齐');
  eq(plan.counts.themes.created, 0, '场景1: 按路径对齐，无重复主题');
  const conflicts = plan.conflicts.filter((c) => c.field.type === 'assignment');
  eq(conflicts.length, 1, '场景1: 仅 1 处判断冲突（同一编码员B改同项且不同）');
  eq(conflicts[0]?.segment?.localId, 's3', '场景1: 冲突定位到本地 s3');
  eq(conflicts[0]?.packageValue, ['教育经历'], '场景1: 冲突包值=教育经历(路径)');
  eq(conflicts[0]?.localValue, ['家庭支持'], '场景1: 冲突本地值=家庭支持(路径)');
  ok(plan.counts.assignments.added >= 1, '场景1: X2 教师影响计入新增');

  let threw = false;
  try { applyMerge(local0, offlinePack, plan); } catch { threw = true; }
  ok(threw, '场景1: 未裁决时拒绝写入');

  setConflictResolution(plan, conflicts[0].id, 'takePackage');
  const merged = applyMerge(local0, offlinePack, plan);
  eq(merged.segments.find((s) => s.id === 's3').assignments.B, ['ta'], '场景1: 裁决后 s3 的B列=教育经历');
  eq(merged.segments.find((s) => s.id === 's2').assignments.B, ['tb'], '场景1: s2 的B列自动并入教师影响');
  eq(merged.segments.find((s) => s.id === 's1').assignments.A, ['ta'], '场景1: 离线端A列改动不影响本地A');
  eq(merged.segments.find((s) => s.id === 's1').assignments.B, ['ta'], '场景1: s1 的B列维持本地');
  eq(merged.themes.length, 3, '场景1: 主题不重复');
}

// ---- 场景 2：不同编码员改同一段 → 不冲突，两列各自保留 ----
{
  const local2 = makeState();
  const base = buildPackage(local2, 'A');
  const remote2 = structuredClone(base.state);
  remote2.segments.find((s) => s.id === 's2').assignments.A = ['tc'];
  local2.segments.find((s) => s.id === 's2').assignments.B = ['tb'];
  const pack2 = { ...base, state: remote2 };
  const plan2 = prepareMerge(local2, pack2);
  eq(plan2.conflicts.length, 0, '场景2: 跨编码员不冲突');
  const merged2 = applyMerge(local2, pack2, plan2);
  eq(merged2.segments.find((s) => s.id === 's2').assignments.A, ['tc'], '场景2: 并入A的家庭支持');
  eq(merged2.segments.find((s) => s.id === 's2').assignments.B, ['tb'], '场景2: 保留本地B的教师影响');
}

// ---- 场景 3：旧包缺指纹缺基线 → 迁移清单 + 复核，不静默覆盖，不建重复 ----
{
  const local3 = makeState();
  const legacy = buildPackage(local3, 'B');
  delete legacy.base;
  legacy.state.segments.forEach((s) => delete s.fingerprint);
  legacy.state.transcripts.forEach((t) => delete t.sourceKey);
  legacy.state.segments.find((s) => s.id === 's2').assignments.B = ['tb'];
  const plan3 = prepareMerge(local3, legacy);
  ok(plan3.migration.some((m) => m.code === 'legacy-no-fingerprint'), '场景3: 列出缺指纹迁移项');
  ok(plan3.migration.some((m) => m.code === 'legacy-no-base'), '场景3: 列出缺基线迁移项');
  ok(plan3.segmentMappings.every((m) => m.kind !== 'unmatched'), '场景3: 重算指纹后仍全部对齐');
  ok(plan3.reviews.some((r) => r.code === 'legacy-assignment'), '场景3: 无基线判断进入复核清单');
  const merged3 = applyMerge(local3, legacy, plan3);
  eq(merged3.segments.find((s) => s.id === 's2').assignments.B, ['tb'], '场景3: 保守并集纳入离线判断');
  eq(merged3.segments.length, 3, '场景3: 不产生重复片段');
}

// ---- 场景 4：访谈对得上但有一段完全对不上 → unmatched 阻塞 ----
{
  const local4 = makeState();
  const pkg4 = buildPackage(local4, 'B');
  pkg4.state.segments.push({
    id: 's99', transcriptId: pkg4.state.transcripts[0].id, order: 9, speaker: '王梅', time: '00:99',
    text: '这是本地完全没有的一句全新的话，关于辞职远行和异乡漂泊。', assignments: { A: [], B: ['ta'] }, note: ''
  });
  const plan4 = prepareMerge(local4, pkg4);
  ok(plan4.segmentMappings.some((m) => m.kind === 'unmatched'), '场景4: 对不上片段标 unmatched');
  let threw4 = false;
  try { applyMerge(local4, pkg4, plan4); } catch { threw4 = true; }
  ok(threw4, '场景4: unmatched 时拒绝提交');
}

// ---- 场景 5：检查点回滚 = 整包撤回 ----
{
  const local5 = makeState();
  const beforeRev = local5.revision;
  const ancestor = makeState();
  const pack = buildPackage(reId(ancestor), 'B');
  const remote5 = structuredClone(pack.state);
  local5.segments.find((s) => s.id === 's2').assignments.B = ['tc'];
  remote5.segments.find((s) => s.id === 'X2').assignments.B = ['ZA'];
  const p5 = prepareMerge(local5, { ...pack, state: remote5 });
  const c = p5.conflicts[0];
  setConflictResolution(p5, c.id, 'takePackage');
  const afterState = applyMerge(local5, { ...pack, state: remote5 }, p5);
  const rolled = rollbackState(structuredClone(local5));
  eq(rolled.segments.find((s) => s.id === 's2').assignments.B, ['tc'], '场景5: 撤回恢复到合并前状态(s2 保留本地改动 tc)');
  eq(rolled.revision, beforeRev, '场景5: 撤回保留合并前修订号');
  ok(rolled.audit.some((a) => a.action === '撤回离线编码包'), '场景5: 撤回写入审计');
  ok(afterState.segments.find((s) => s.id === 's2').assignments.B.includes('ta'), '场景5: 合并后 s2 含教育经历');
}

// ---- 场景 6：主题改名 → 路径分叉，按新主题处理，不错认为同一修改 ----
{
  const local6 = makeState();
  const pkg6 = buildPackage(local6, 'B');
  pkg6.state.themes.find((t) => t.id === 'tb').name = '恩师指引';
  const plan6 = prepareMerge(local6, pkg6);
  eq(plan6.themeMappings.find((m) => m.path === '教育经历 / 恩师指引')?.localId, null, '场景6: 改名路径本地无匹配');
  eq(plan6.counts.themes.created, 1, '场景6: 改名主题新建 1 个');
}

// ---- 场景 7：双方都没相对基线改动 → 不产生多余写入 ----
{
  const local7 = makeState();
  const pack7 = buildPackage(local7, 'B');
  const plan7 = prepareMerge(local7, pack7);
  eq(plan7.conflicts.length, 0, '场景7: 无冲突');
  eq(plan7.counts.assignments.added, 0, '场景7: 无新增判断');
  const merged7 = applyMerge(local7, pack7, plan7);
  eq(merged7.themes.length, 3, '场景7: 主题数量不变');
}

console.log(`\n${passed} 项断言通过`);
if (process.exitCode) process.exit(process.exitCode);

// ---- 场景 8：同访谈来源、片段原文有口误修正（fuzzy），手工确认后并入 ----
{
  const local8 = makeState();
  const pack8 = buildPackage(local8, 'B');
  // 离线端 s3 文本被轻微修订（口误/标点），删除旧指纹以模拟真实的原文漂移
  const seg8 = pack8.state.segments.find((s) => s.id === 's3');
  seg8.text = '周老师拿旧地图来讲课。';
  delete seg8.fingerprint;
  seg8.assignments.B = ['ta']; // B 改教育经历
  const before = prepareMerge(local8, pack8);
  const fuzzy = before.segmentMappings.find((m) => m.kind === 'fuzzy');
  ok(!!fuzzy, '场景8: 文本小异被识别为 fuzzy 建议而非重复');
  // 手工把该包片段确认到本地 s3
  const after = prepareMerge(local8, pack8, { [fuzzy.packageId]: 's3' });
  eq(after.segmentMappings.find((m) => m.packageId === fuzzy.packageId)?.kind, 'manual', '场景8: 手工确认后标记 manual');
  eq(after.segmentMappings.filter((m) => m.kind === 'unmatched').length, 0, '场景8: 无未对齐');
  // s3 本地 B 原为 tb，包内改为 ta，基线为 tb → 仅离线变动，应直接并入
  const merged8 = applyMerge(local8, pack8, after);
  eq(merged8.segments.find((s) => s.id === 's3').assignments.B, ['ta'], '场景8: 手工对齐后并入离线判断(教育经历)');
}
