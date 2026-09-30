import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { CoderId } from '../types';
import type { useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

const readFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(file);
});

export default function MergePackagesDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const plan = () => props.store.mergePlan();
  const [busy, setBusy] = createSignal(false);
  const [resultNotice, setResultNotice] = createSignal<string | null>(null);
  const [importError, setImportError] = createSignal<string | null>(null);

  onMount(() => {
    if (props.open && !plan()) props.store.resumePendingCheckpoint();
  });

  const coderLabel = (coder: CoderId) => coder === 'A' ? props.store.state.coderA : props.store.state.coderB;

  const unresolved = createMemo(() => plan()?.conflicts.filter((item) => !item.resolution).length ?? 0);
  const migrationItems = createMemo(() => plan()?.migration.filter((item) => item.backfilled) ?? []);
  const judgmentCount = createMemo(() =>
    (plan()?.segmentMerges.reduce((sum, merge) => sum + merge.changed.length, 0) ?? 0)
    + (plan()?.conflicts.filter((item) => item.resolution === 'incoming').length ?? 0));

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setImportError(null);
    setResultNotice(null);
    try {
      const raw = await readFile(file);
      await props.store.importReturnedPackage(raw, file.name);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    setBusy(true);
    setResultNotice(null);
    const outcome = await props.store.applyImportedPackage();
    setBusy(false);
    if (outcome.ok) {
      setResultNotice(`合并已写入本地库：新主题 ${outcome.counts.themes}、新访谈 ${outcome.counts.transcripts}、新片段 ${outcome.counts.segments}、判断更新 ${outcome.counts.judgments}。`);
      props.onClose();
    }
  };

  const handleRollback = async () => {
    setBusy(true);
    await props.store.rollbackPendingCheckpoint();
    setBusy(false);
    setResultNotice('已从检查点恢复，整包改动全部撤回。');
  };

  const handleCancel = () => {
    props.store.cancelImportedPackage();
    setResultNotice(null);
    props.onClose();
  };

  const handleClose = () => {
    // 有待处理检查点时保留计划（重开可继续）；仅预览或已取消时清空视图
    if (!props.store.hasPendingCheckpoint()) props.store.cancelImportedPackage();
    props.onClose();
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={handleClose}>
      <section class="modal-card wide merge-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <div><span class="eyebrow">MERGE PACKAGE</span><h2>合并离线编码包</h2></div>
          <button class="modal-close" onClick={handleClose}>×</button>
        </header>

        <Show when={!plan()}>
          <p class="modal-intro">选择编码员带回的 JSON 完成包。系统会按 <strong>访谈来源 + 原文指纹</strong> 对齐片段、按 <strong>主题路径</strong> 对齐主题，再与发出工作包时的基线做三方合并。</p>
          <label class="package-file">
            <input type="file" accept="application/json,.json" disabled={busy()} onChange={(event) => void handleFile(event.currentTarget.files?.[0])} />
          </label>
          <Show when={importError()}><div class="disagreement">{importError()}</div></Show>
          <Show when={resultNotice()}><div class="agreement">{resultNotice()}</div></Show>
        </Show>

        <Show when={plan()}>
          {(getPlan) => (
            <div class="merge-body">
              <div class="merge-summary-line">
                <strong>{getPlan().pkg.coderName ?? '匿名编码员'}</strong> 的编码包
                <Show when={!getPlan().hasBase} fallback={<span class="tag tag-ok">含共同基线，可三方合并</span>}>
                  <span class="tag tag-warn">旧数据包无基线，仅按本地空缺补入</span>
                </Show>
              </div>

              <Show when={migrationItems().length}>
                <div class="merge-section">
                  <h4>迁移清单（旧数据缺指纹，已按下表补算后再对齐）</h4>
                  <div class="migration-list">
                    <For each={migrationItems()}>{(item) => (
                      <div class="migration-item"><span class="tag">{item.kind === 'transcript' ? '访谈' : '片段'}</span><span>{item.detail}</span></div>
                    )}</For>
                  </div>
                </div>
              </Show>

              <Show when={getPlan().segmentMapping.unknownSource.length || getPlan().segmentMapping.unmatched.length}>
                <div class="merge-section">
                  <h4>无法对齐的片段</h4>
                  <For each={getPlan().segmentMapping.unknownSource}>
                    {(id) => <div class="migration-item"><span class="tag tag-warn">来源缺失</span><span>包内片段 {id} 找不到访谈来源，已跳过</span></div>}
                  </For>
                  <For each={getPlan().segmentMapping.unmatched}>
                    {(id) => <div class="migration-item"><span class="tag tag-warn">指纹不匹配</span><span>包内片段 {id} 的原文与本地任何片段不一致，已跳过</span></div>}
                  </For>
                </div>
              </Show>

              <div class="merge-stats">
                <div><strong>{getPlan().createdThemes.length}</strong><span>待新建主题</span></div>
                <div><strong>{getPlan().newTranscripts.length}</strong><span>待新建访谈</span></div>
                <div><strong>{getPlan().segmentMerges.filter((m) => m.isNewTranscript).length}</strong><span>待新增片段</span></div>
                <div><strong>{judgmentCount()}</strong><span>判断更新</span></div>
                <div classList={{ 'stat-conflict': true, active: unresolved() > 0 }}><strong>{getPlan().conflicts.length}</strong><span>待裁决冲突（剩 {unresolved()}）</span></div>
              </div>

              <Show when={getPlan().createdThemes.length}>
                <div class="merge-section">
                  <h4>按路径新建的主题</h4>
                  <div class="path-list"><For each={getPlan().createdThemes}>{(item) => <div class="path-item">＋ {item.path}</div>}</For></div>
                </div>
              </Show>

              <Show when={getPlan().themeMapping.metadataDiverged.length}>
                <div class="merge-section">
                  <h4>主题元数据两边不同</h4>
                  <p class="merge-hint">不阻断合并：本地定义/备忘录优先，本地为空时采用工作包内容，典型示例取并集。</p>
                  <div class="path-list"><For each={getPlan().themeMapping.metadataDiverged}>{(path) => <div class="path-item muted-path">{path}</div>}</For></div>
                </div>
              </Show>

              <Show when={getPlan().conflicts.length}>
                <div class="merge-section conflict-section">
                  <h4>需要研究者裁决：同一位编码员两边改动了同一判断</h4>
                  <div class="conflict-list">
                    <For each={getPlan().conflicts}>{(conflict, index) => (
                      <div class="conflict-card" classList={{ resolved: Boolean(conflict.resolution) }}>
                        <div class="conflict-head">
                          <span class="avatar-mini">{conflict.coder}</span>
                          <strong>{coderLabel(conflict.coder)}</strong>
                          <span class="conflict-where">{conflict.sourceLabel} · {conflict.time} · {conflict.speaker}</span>
                        </div>
                        <blockquote class="conflict-quote">“{conflict.text}”</blockquote>
                        <div class="conflict-options">
                          <label class={conflict.resolution === 'local' ? 'picked' : ''}>
                            <input type="radio" name={`conflict-${index()}`} checked={conflict.resolution === 'local'} onChange={() => props.store.resolveConflict(index(), 'local')} />
                            <span>保留本地
                              <small>{conflict.localPaths.length ? conflict.localPaths.join('；') : '（未编码）'}</small>
                            </span>
                          </label>
                          <label class={conflict.resolution === 'incoming' ? 'picked' : ''}>
                            <input type="radio" name={`conflict-${index()}`} checked={conflict.resolution === 'incoming'} onChange={() => props.store.resolveConflict(index(), 'incoming')} />
                            <span>采用编码包
                              <small>{conflict.incomingPaths.length ? conflict.incomingPaths.join('；') : '（未编码）'}</small>
                            </span>
                          </label>
                          <div class="conflict-base">基线：{conflict.basePaths.length ? conflict.basePaths.join('；') : '（未编码）'}</div>
                        </div>
                      </div>
                    )}</For>
                  </div>
                </div>
              </Show>

              <Show when={props.store.mergeError()}>
                <div class="disagreement">
                  {props.store.mergeError()}
                  <div class="button-row" style={{ 'margin-top': '8px' }}>
                    <button class="button secondary" disabled={busy()} onClick={() => void handleApply()}>重试应用</button>
                    <button class="button danger" disabled={busy()} onClick={() => void handleRollback()}>整包撤回</button>
                  </div>
                </div>
              </Show>

              <footer class="merge-footer">
                <button class="button secondary" disabled={busy()} onClick={() => void handleRollback()}>从检查点撤回</button>
                <div class="button-row">
                  <button class="button secondary" disabled={busy()} onClick={handleCancel}>取消（保留本地库）</button>
                  <button class="button primary" disabled={busy() || unresolved() > 0} onClick={() => void handleApply()}>
                    {unresolved() > 0 ? `请先裁决 ${unresolved()} 处分歧` : '应用合并'}
                  </button>
                </div>
              </footer>
            </div>
          )}
        </Show>
      </section>
    </div>
  );
}
