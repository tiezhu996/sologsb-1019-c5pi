import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  CheckpointHistoryEntry,
  CoderId,
  CodingPackage,
  CodingState,
  MergeCheckpoint,
  MergePlan,
  PersistedEnvelope,
  Segment,
  Theme
} from '../types';
import { readEnvelope, writeEnvelope } from '../utils/db';
import {
  applyMergeToDraft,
  buildMergePlan,
  buildMigration,
  clearPendingCheckpoint,
  discardPendingCheckpoint,
  downloadPackage,
  issuePackage,
  listCheckpointHistory,
  loadPendingCheckpoint,
  markCheckpointRolledBack,
  parsePackage,
  saveCheckpoint,
  summarizePackage,
  unresolvedConflictCount
} from '../utils/merge';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const OFFLINE_PREVIOUS_KEY = 'sologsb-1019-offline-previous-v1';
const TAB_ID = crypto.randomUUID();

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CodingState;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
};

const cloneState = <T,>(value: T): T => structuredClone(unwrap(value) as T);

const [state, setState] = createStore<CodingState>(loadLocal());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [offlineSession, setOfflineSession] = createSignal<{ coderName: string; issuedAt: string } | null>(null);
const [mergePlan, setMergePlan] = createSignal<MergePlan | null>(null);
const [mergeError, setMergeError] = createSignal<string | null>(null);
const [pendingCheckpoint, setPendingCheckpoint] = createSignal<MergeCheckpoint | null>(null);
const [checkpointHistory, setCheckpointHistory] = createSignal<CheckpointHistoryEntry[]>([]);
let channel: BroadcastChannel | null = null;
let hydrating = false;
let saveTimer: number | undefined;

const persistNow = async (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  const envelope: PersistedEnvelope = {
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    writerId: TAB_ID,
    state: snapshot
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  await writeEnvelope(envelope);
  setLastSavedAt(new Date());
  channel?.postMessage(envelope);
};

const persist = (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void persistNow(snapshot); }, 180);
};

createEffect(() => {
  const snapshot = cloneState(state);
  if (!storageReady()) return;
  persist(snapshot);
});

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
  setRedoStack([]);
  const next = cloneState(state);
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  persist(next);
};

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const stored = await readEnvelope();
      const local = cloneState(state);
      if (stored && (stored.revision > local.revision || stored.updatedAt > local.updatedAt)) {
        setRemoteEnvelope(stored);
      }
    } finally {
      setStorageReady(true);
    }

    if (state.offlineBase) setOfflineSession({ coderName: '', issuedAt: state.offlineBase.issuedAt });
    setCheckpointHistory(listCheckpointHistory());
    setPendingCheckpoint(await loadPendingCheckpoint());

    // 旧数据迁移：为缺失来源/原文指纹的记录补算一次
    const migrated = cloneState(state);
    const items = await buildMigration(migrated.transcripts, migrated.segments);
    if (items.some((item) => item.backfilled)) {
      migrated.revision = state.revision + 1;
      migrated.updatedAt = new Date().toISOString();
      migrated.audit.unshift({
        id: crypto.randomUUID(),
        at: migrated.updatedAt,
        action: '迁移旧数据',
        detail: `补算 ${items.filter((item) => item.backfilled).length} 条来源/原文指纹`
      });
      setState(reconcile(migrated, { merge: false }));
      await persistNow(migrated);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent<PersistedEnvelope>) => {
        const incoming = event.data;
        if (!incoming || incoming.writerId === TAB_ID) return;
        if (incoming.revision === state.revision && incoming.updatedAt === state.updatedAt) return;
        setRemoteEnvelope(incoming);
      };
    }
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, cloneState(state)]);
    setState(reconcile(previous, { merge: false }));
    persist(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, cloneState(state)]);
    setState(reconcile(next, { merge: false }));
    persist(next);
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    if (coder === 'A') setState('coderA', name);
    else setState('coderB', name);
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const codes = new Set(segment.assignments[coder]);
      if (enabled) codes.add(themeId);
      else codes.delete(themeId);
      segment.assignments[coder] = [...codes];
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].includes(themeId)) segment.assignments[coder].push(themeId);
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== sourceId));
          if (segment.assignments[coder].includes(sourceId)) codes.add(targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => id === sourceId ? newId : id);
          }
        });
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${crypto.randomUUID()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  const exportCoding = (format: 'json' | 'csv') => {
    const segmentMap = new Map(state.segments.map((segment) => [segment.id, segment]));
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => {
          const names: string[] = [];
          let current = themeMap.get(id);
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? themeMap.get(current.parentId) : undefined;
          }
          return names.join(' / ');
        }) : ['未编码'];
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segmentMap.get(segment.id)?.note ?? ''].map(escape).join(','));
      });
    });
    return `\uFEFF${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const keepLocalVersion = () => {
    setRemoteEnvelope(null);
    transaction('处理多标签冲突', '保留当前标签页版本并生成新修订', () => undefined);
  };

  const applyRemoteVersion = () => {
    const remote = remoteEnvelope();
    if (!remote) return;
    setUndoStack((items) => [...items, cloneState(state)]);
    setRedoStack([]);
    setState(reconcile(remote.state, { merge: false }));
    setRemoteEnvelope(null);
  };

  /* ---------------- 离线编码包 ---------------- */

  const sendOfflinePackage = async (coderName: string) => {
    const pkg = await issuePackage(cloneState(state), coderName);
    downloadPackage(pkg);
  };

  /** 在编码员自己的电脑上打开工作包：载入 work 快照，记录离开主库时的现场 */
  const openOfflinePackage = async (raw: string): Promise<string> => {
    const pkg = parsePackage(raw);
    if (!state.offlineBase) localStorage.setItem(OFFLINE_PREVIOUS_KEY, JSON.stringify(cloneState(state)));
    const work = cloneState(pkg.work) as CodingState;
    work.revision = pkg.work.revision;
    work.updatedAt = pkg.work.updatedAt;
    work.activeTranscriptId = pkg.work.transcripts[0]?.id ?? '';
    work.activeSegmentId = pkg.work.segments[0]?.id ?? '';
    work.activeThemeId = pkg.work.themes[0]?.id ?? '';
    work.audit = state.audit;
    work.offlineBase = pkg.base ? { revision: pkg.base.revision, issuedAt: pkg.issuedAt, base: pkg.base } : null;
    setUndoStack([]);
    setRedoStack([]);
    setState(reconcile(work, { merge: false }));
    setOfflineSession({ coderName: pkg.coderName ?? '', issuedAt: pkg.issuedAt });
    await persistNow(work);
    return summarizePackage(pkg);
  };

  /** 编码员完工：导出保持 base 不变、work 为当前成果的工作包 */
  const returnOfflinePackage = async () => {
    const offlineBase = state.offlineBase;
    if (!offlineBase) throw new Error('当前不是从带基线的工作包进入的离线模式，无法生成带回包');
    const coderName = offlineSession()?.coderName;
    const returnedAt = new Date().toISOString();
    const pkg: CodingPackage = {
      kind: 'coding-package',
      packageVersion: 1,
      issuedAt: offlineBase.issuedAt,
      returnedAt,
      coderName: coderName || undefined,
      base: offlineBase.base,
      work: {
        revision: state.revision,
        updatedAt: state.updatedAt,
        coderA: state.coderA,
        coderB: state.coderB,
        transcripts: structuredClone(state.transcripts),
        segments: structuredClone(state.segments),
        themes: structuredClone(state.themes)
      }
    };
    downloadPackage(pkg, `离线编码包-完成-${(coderName || '编码员')}-${returnedAt.slice(0, 10)}.json`);
  };

  /** 编码员电脑上退出离线模式：回到打开工作包之前该电脑自己的库 */
  const exitOfflineSession = async () => {
    const previous = localStorage.getItem(OFFLINE_PREVIOUS_KEY);
    setOfflineSession(null);
    setUndoStack([]);
    setRedoStack([]);
    if (previous) {
      localStorage.removeItem(OFFLINE_PREVIOUS_KEY);
      const restored = JSON.parse(previous) as CodingState;
      setState(reconcile(restored, { merge: false }));
      await persistNow(restored);
    }
  };

  /* ---------------- 合并编码包 ---------------- */

  const importReturnedPackage = async (raw: string, fileName: string): Promise<MergePlan> => {
    const pkg = parsePackage(raw);
    const plan = await buildMergePlan(cloneState(state), pkg);
    setMergePlan(plan);
    setMergeError(null);
    const checkpoint: MergeCheckpoint = {
      id: `cp-${crypto.randomUUID()}`,
      kind: 'merge',
      packageFileName: fileName,
      packageSummary: summarizePackage(pkg),
      createdAt: new Date().toISOString(),
      before: cloneState(state),
      plan
    };
    await saveCheckpoint(checkpoint);
    setPendingCheckpoint(checkpoint);
    return plan;
  };

  const resolveConflict = (index: number, resolution: 'local' | 'incoming') => {
    const plan = mergePlan();
    if (!plan || !plan.conflicts[index]) return;
    const next = structuredClone(plan);
    next.conflicts[index].resolution = resolution;
    setMergePlan(next);
    const current = pendingCheckpoint();
    if (current) {
      const updated = { ...current, plan: next };
      setPendingCheckpoint(updated);
      void saveCheckpoint(updated);
    }
  };

  /** 应用合并：写入双存储；任一步失败都保留检查点，可恢复后重试或整包撤回 */
  const applyImportedPackage = async (): Promise<{ ok: true; counts: ReturnType<typeof applyMergeToDraft> } | { ok: false; error: string }> => {
    const plan = mergePlan();
    if (!plan) return { ok: false, error: '没有待应用的合并计划' };
    const remaining = unresolvedConflictCount(plan);
    if (remaining > 0) return { ok: false, error: `还有 ${remaining} 处编码分歧等待研究者裁决` };

    const pending = await loadPendingCheckpoint();
    const before = pending?.before ?? cloneState(state);
    const next = structuredClone(before);
    const counts = applyMergeToDraft(next, plan);
    next.revision = before.revision + 1;
    next.updatedAt = new Date().toISOString();
    next.audit.unshift({
      id: crypto.randomUUID(),
      at: next.updatedAt,
      action: '合并离线编码包',
      detail: `${plan.pkg.coderName ?? '编码员'}：新主题 ${counts.themes}、新访谈 ${counts.transcripts}、新片段 ${counts.segments}、判断 ${counts.judgments}`
    });
    next.audit = next.audit.slice(0, 250);

    try {
      setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
      setRedoStack([]);
      setState(reconcile(next, { merge: false }));
      await persistNow(next); // 双写，失败会抛出并保留检查点
      await clearPendingCheckpoint(counts);
      setPendingCheckpoint(null);
      setCheckpointHistory(listCheckpointHistory());
      setMergePlan(null);
      return { ok: true, counts };
    } catch (error) {
      const message = `写入本地库失败：${error instanceof Error ? error.message : String(error)}。已保留检查点，可重试应用或整包撤回。`;
      setMergeError(message);
      return { ok: false, error: message };
    }
  };

  const cancelImportedPackage = () => {
    setMergePlan(null);
    setMergeError(null);
    void discardPendingCheckpoint();
    setPendingCheckpoint(null);
  };

  /** 重开时继续应用上次未完成的合并 */
  const resumePendingCheckpoint = (): MergePlan | null => {
    const pending = pendingCheckpoint();
    if (!pending) return null;
    setMergePlan(pending.plan);
    setMergeError(null);
    return pending.plan;
  };

  const hasPendingCheckpoint = () => pendingCheckpoint() !== null;

  /** 从检查点恢复到应用前的状态（整包撤回） */
  const rollbackPendingCheckpoint = async () => {
    const pending = await loadPendingCheckpoint();
    if (!pending) return;
    const before = cloneState(pending.before);
    setUndoStack([]);
    setRedoStack([]);
    setState(reconcile(before, { merge: false }));
    await persistNow(before);
    await markCheckpointRolledBack();
    setPendingCheckpoint(null);
    setCheckpointHistory(listCheckpointHistory());
    setMergePlan(null);
    setMergeError(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt,
    // 离线编码包
    sendOfflinePackage,
    openOfflinePackage,
    returnOfflinePackage,
    exitOfflineSession,
    offlineSession,
    // 合并与检查点
    importReturnedPackage,
    applyImportedPackage,
    cancelImportedPackage,
    resolveConflict,
    resumePendingCheckpoint,
    hasPendingCheckpoint,
    rollbackPendingCheckpoint,
    mergePlan,
    mergeError,
    checkpointHistory
  };
}
