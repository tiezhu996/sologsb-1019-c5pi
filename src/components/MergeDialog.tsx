import { For, Show, createMemo, createSignal } from 'solid-js';
import type { CoderId } from '../types';
import type { useCodingStore } from '../store/coding-store';
import type { CodingPackage, MergeConflict, MergePlan, SegmentMapping } from '../merge/types';
import { isBlocking } from '../merge/types';

type Store = ReturnType<typeof useCodingStore>;
type Step = 'select' | 'review' | 'conflicts' | 'done';

const levelLabel: Record<string, string> = { info: '提示', warning: '迁移', blocking: '阻塞' };

export default function MergeDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const [step, setStep] = createSignal<Step>('select');
  const [error, setError] = createSignal('');
  const [pkg, setPkg] = createSignal<CodingPackage | null>(null);
  const [plan, setPlan] = createSignal<MergePlan | null>(null);
  const [manual, setManual] = createSignal<Record<string, string | null>>({});
  const [busy, setBusy] = createSignal(false);
  const [resultMsg, setResultMsg] = createSignal('');
  const [exportCoder, setExportCoder] = createSignal<CoderId>('B');
  const [exportNote, setExportNote] = createSignal('');

  const reset = () => {
    setStep('select'); setError(''); setPkg(null); setPlan(null);
    setManual({}); setBusy(false); setResultMsg(''); setExportNote('');
  };
  const close = () => { reset(); props.onClose(); };

  const onFile = async (file: File) => {
    setError('');
    const raw = await file.text();
    const result = await props.store.previewPackage(raw);
    if (!result.ok) { setError(result.error); return; }
    setPkg(result.pkg);
    setPlan(result.plan);
    setStep('review');
  };

  // 手工调整某条片段对齐后重新预演（保留已做裁决）
  const relink = (packageSegmentId: string, value: string) => {
    const next = { ...manual(), [packageSegmentId]: value === '' ? null : value };
    setManual(next);
    const current = pkg();
    if (!current) return;
    setPlan(props.store.repreview(current, next, plan() ?? undefined));
  };

  const localSegmentsFor = (mapping: SegmentMapping) => {
    const p = pkg();
    if (!p) return [];
    const transcriptMapping = plan()?.transcriptMappings.find((item) => item.packageId
      === p.state.segments.find((s) => s.id === mapping.packageId)?.transcriptId);
    const localTranscriptId = transcriptMapping?.localId;
    if (!localTranscriptId) return [];
    return props.store.state.segments.filter((s) => s.transcriptId === localTranscriptId);
  };

  const blocking = createMemo(() => (plan() ? isBlocking(plan()!) : true));
  const pendingConflicts = createMemo(() => plan()?.conflicts.filter((c) => c.resolution === 'pending') ?? []);

  const submit = async () => {
    const currentPkg = pkg();
    const currentPlan = plan();
    if (!currentPkg || !currentPlan) return;
    setBusy(true);
    const result = await props.store.commitMerge(currentPkg, currentPlan);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setResultMsg('合并已写入检查点并落盘。可在需要时用撤销回退，或从顶部横幅撤回整包。');
    setStep('done');
  };

  const counts = () => plan()?.counts;

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={close}>
      <section class="modal-card wide merge-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="merge-title">
        <header>
          <div><span class="eyebrow">OFFLINE MERGE</span><h2 id="merge-title">合并离线编码包</h2></div>
          <button class="modal-close" onClick={close}>×</button>
        </header>

        <div class="merge-steps">
          {(['select', 'review', 'conflicts', 'done'] as Step[]).map((s, i) => (
            <span classList={{ active: step() === s, reached: ['select', 'review', 'conflicts', 'done'].indexOf(step()) >= i }}>
              {i + 1}. {s === 'select' ? '选择数据包' : s === 'review' ? '对齐与迁移清单' : s === 'conflicts' ? '裁决冲突' : '完成'}
            </span>
          ))}
        </div>

        <Show when={error()}><div class="warning-box merge-error">{error()}</div></Show>

        {/* 步骤 1：下发或读入 */}
        <Show when={step() === 'select'}>
          <p class="modal-intro">两位编码员离线编码后带回编码包。系统按<strong>访谈来源 + 原文指纹</strong>对齐片段、按<strong>主题路径</strong>对齐主题，再合并该编码员那一列判断；只有同一位编码员改动同一项且内容不同时才会请你裁决。</p>
          <div class="merge-export-box">
            <label class="field-label">为本机编码员生成离线编码包
              <div class="inline-input">
                <select class="native-select" value={exportCoder()} onChange={(e) => setExportCoder(e.currentTarget.value as CoderId)}>
                  <option value="A">编码员 A · {props.store.state.coderA}</option>
                  <option value="B">编码员 B · {props.store.state.coderB}</option>
                </select>
              </div>
            </label>
            <label class="field-label">备注（可选）
              <input class="native-input full" value={exportNote()} onInput={(e) => setExportNote(e.currentTarget.value)} placeholder="例如：2026-09 田野批次" />
            </label>
            <div class="button-row"><button class="button secondary" onClick={() => props.store.exportCodingPackage(exportCoder(), exportNote() || undefined)}>下载离线编码包</button></div>
            <p class="muted">编码包含全量快照、原文指纹与下发基线；编码员在另一台机器用同一工具打开并编码即可。</p>
          </div>
          <DividerLabel text="带回编码包后" />
          <label class="drop-zone">
            <input type="file" accept="application/json,.json" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void onFile(f); }} />
            <span>选择编码员带回的 .json 编码包进行预演合并</span>
          </label>
        </Show>

        {/* 步骤 2：对齐 + 迁移清单 */}
        <Show when={step() === 'review' && plan() && pkg() ? { plan: plan()!, pkg: pkg()! } : null} keyed>
          {(ctx) => {
            const currentPlan = ctx.plan;
            const currentPkg = ctx.pkg;
            const c = currentPlan.counts;
            return <>
              <div class="merge-summary">
                <div><strong>{currentPkg.coderName}</strong><span>编码员 {currentPkg.coder} · 离线包</span></div>
                <div><strong>{c.segments.fingerprint + c.segments.manual}</strong><span>片段精确/确认对齐</span></div>
                <div><strong>{c.segments.fuzzy}</strong><span>相似度建议</span></div>
                <div><strong>{c.segments.unmatched}</strong><span>未对齐（阻塞）</span></div>
                <div><strong>{c.themes.created}</strong><span>按路径新建主题</span></div>
                <div><strong>{currentPlan.conflicts.length}</strong><span>待裁决冲突</span></div>
              </div>

              <Show when={currentPlan.migration.length}>
                <h4 class="merge-section-title">迁移清单（旧数据包）</h4>
                <div class="merge-list">
                  <For each={currentPlan.migration}>{(item) => (
                    <div class={`migration-item ${item.level}`}>
                      <span class="tag">{levelLabel[item.level]}</span>
                      <div><strong>{item.message}</strong>{item.detail && <pre>{item.detail}</pre>}</div>
                    </div>
                  )}</For>
                </div>
              </Show>

              <Show when={currentPlan.reviews.length}>
                <h4 class="merge-section-title">需研究者确认（无法判定改动归属，已保守预合并）</h4>
                <div class="merge-list">
                  <For each={currentPlan.reviews}>{(review) => (
                    <label class="review-item" classList={{ acknowledged: review.acknowledged }}>
                      <input type="checkbox" checked={review.acknowledged} onChange={(e) => props.store.markReview(currentPlan, review.id, e.currentTarget.checked)} />
                      <div><strong>{review.message}</strong>{review.detail && <pre>{review.detail}</pre>}</div>
                    </label>
                  )}</For>
                </div>
              </Show>

              <h4 class="merge-section-title">片段对齐（{currentPlan.segmentMappings.length}）</h4>
              <div class="align-list">
                <For each={currentPlan.segmentMappings}>{(mapping) => {
                  const locals = localSegmentsFor(mapping);
                  return (
                    <div class={`align-row ${mapping.kind}`}>
                      <div class="align-kind">
                        {mapping.kind === 'fingerprint' && '指纹一致'}
                        {mapping.kind === 'manual' && '已确认'}
                        {mapping.kind === 'fuzzy' && `相似 ${Math.round((mapping.similarity ?? 0) * 100)}%`}
                        {mapping.kind === 'new' && '随新访谈加入'}
                        {mapping.kind === 'unmatched' && <b>未对齐</b>}
                      </div>
                      <div class="align-text"><span class="align-time">{mapping.time} · {mapping.speaker}</span><p>{mapping.text}</p></div>
                      <Show when={mapping.kind === 'fuzzy' || mapping.kind === 'unmatched' || mapping.kind === 'manual'}>
                        <select class="native-select align-select" value={mapping.kind === 'new' ? '' : (manual()[mapping.packageId!] ?? mapping.localId ?? '')} onChange={(e) => relink(mapping.packageId!, e.currentTarget.value)}>
                          <option value="">— 不作为本地片段（视为新增）—</option>
                          <For each={locals}>{(s) => <option value={s.id}>{s.time} · {s.speaker}：{s.text.slice(0, 24)}…</option>}</For>
                        </select>
                      </Show>
                    </div>
                  );
                }}</For>
              </div>
              <Show when={blocking()}>
                <div class="warning-box">仍有<strong>未对齐片段或未确认项</strong>。请在上方逐条确认（指定对应本地片段，或明确判定为新增）后再继续；系统不会自动建立重复片段。</div>
              </Show>
            </>;
          }}
        </Show>

        {/* 步骤 3：冲突裁决 */}
        <Show when={step() === 'conflicts' && plan() && pkg() ? { plan: plan()!, pkg: pkg()! } : null} keyed>
          {(ctx) => (
            <>
              <Show when={pendingConflicts().length === 0}>
                <div class="agreement" style={{ margin: '12px 0' }}>✓ 没有需要裁决的冲突。不同编码员的判断各自独立保留，互不覆盖。</div>
              </Show>
              <div class="conflict-list">
                <For each={ctx.plan.conflicts}>{(conflict) => <ConflictCard conflict={conflict} store={props.store} plan={ctx.plan} coderName={ctx.pkg.coderName} />}</For>
              </div>
            </>
          )}
        </Show>

        {/* 步骤 4：完成 */}
        <Show when={step() === 'done'}>
          <div class="merge-done">
            <p>{resultMsg()}</p>
            <Show when={counts()} keyed>
              {(c) => (
                <ul class="done-stats">
                  <li>新访谈 {c.transcripts.newCount} · 新片段 {c.segments.newCount}</li>
                  <li>按路径新建主题 {c.themes.created}</li>
                  <li>判断更新 {c.assignments.added} 项 · 裁决冲突 {plan()?.conflicts.length ?? 0} 处</li>
                </ul>
              )}
            </Show>
          </div>
        </Show>

        <footer>
          <button class="button secondary" onClick={close}>{step() === 'done' ? '关闭' : '取消'}</button>
          <Show when={step() === 'review'}>
            <button class="button primary" disabled={blocking()} onClick={() => setStep('conflicts')}>下一步：裁决冲突{plan()?.conflicts.length ? `（${pendingConflicts().length} 待处理）` : ''}</button>
          </Show>
          <Show when={step() === 'conflicts'}>
            <button class="button secondary" onClick={() => setStep('review')}>返回对齐</button>
            <button class="button primary" disabled={busy() || pendingConflicts().length > 0} onClick={() => void submit()}>
              {busy() ? '正在写入检查点…' : '提交合并（先存检查点）'}
            </button>
          </Show>
        </footer>
      </section>
    </div>
  );
}

function DividerLabel(props: { text: string }) {
  return <div class="merge-divider"><span>{props.text}</span></div>;
}

function ConflictCard(props: { conflict: MergeConflict; plan: MergePlan; store: Store; coderName: string }) {
  const { conflict } = props;
  const fieldTitle = createMemo(() => {
    if (conflict.field.type === 'assignment') return `编码判断冲突 · 编码员 ${conflict.field.coder}（${props.coderName}）`;
    if (conflict.field.type === 'segmentNote') return '片段备忘冲突';
    return `主题「${conflict.field.path}」${conflict.field.field === 'definition' ? '定义' : '备忘录'}冲突`;
  });
  const renderValue = (v: string[]) => v.length ? v.join(' | ') : '（空）';
  return (
    <div class="conflict-card" classList={{ resolved: conflict.resolution !== 'pending' }}>
      <div class="conflict-head">
        <strong>{fieldTitle()}</strong>
        <span class="tag">{conflict.resolution === 'pending' ? '待裁决' : conflict.resolution === 'takePackage' ? '采用离线包' : conflict.resolution === 'keepLocal' ? '保留本地' : conflict.resolution === 'union' ? '合并保留' : '跳过'}</span>
      </div>
      <Show when={conflict.segment}><div class="conflict-quote">{conflict.segment!.time} · {conflict.segment!.speaker}：{conflict.segment!.text}</div></Show>
      <div class="conflict-values">
        <div class="cv"><span>下发基线</span><p>{renderValue(conflict.baseValue)}</p></div>
        <div class="cv local"><span>本地库</span><p>{renderValue(conflict.localValue)}</p></div>
        <div class="cv pkg"><span>离线包</span><p>{renderValue(conflict.packageValue)}</p></div>
      </div>
      <div class="conflict-choices">
        <label><input type="radio" name={conflict.id} checked={conflict.resolution === 'keepLocal'} onChange={() => props.store.resolveConflict(props.plan, conflict.id, 'keepLocal')} /> 保留本地</label>
        <label><input type="radio" name={conflict.id} checked={conflict.resolution === 'takePackage'} onChange={() => props.store.resolveConflict(props.plan, conflict.id, 'takePackage')} /> 采用离线包</label>
        <label><input type="radio" name={conflict.id} checked={conflict.resolution === 'union'} onChange={() => props.store.resolveConflict(props.plan, conflict.id, 'union')} /> 两者并取</label>
      </div>
    </div>
  );
}
