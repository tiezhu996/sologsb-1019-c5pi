import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { CoderId, CodingState, PersistedEnvelope, Segment, Theme } from '../types';
import { clearCheckpoint, readCheckpoint, readEnvelope, writeCheckpoint, writeEnvelope } from '../utils/db';
import { ensureAlignmentFields } from '../merge/fingerprint';
import {
  applyMerge,
  buildPackage,
  parsePackage,
  prepareMerge,
  rollbackState,
  setConflictResolution,
  acknowledgeReview,
  type ManualLinks
} from '../merge/engine';
import type { CodingPackage, MergeCheckpoint, MergePlan, ResolutionChoice } from '../merge/types';

const STORAGE_KEY = 'sologsb-1019-state-v1';
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

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

const [state, setState] = createStore<CodingState>(loadLocal());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [pendingCheckpoint, setPendingCheckpoint] = createSignal<MergeCheckpoint | null>(null);
let channel: BroadcastChannel | null = null;
let hydrating = false;
let saveTimer: number | undefined;

const persist = (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
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
  }, 180);
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

      // 旧数据一次性回填对齐字段（访谈来源键 + 原文指纹）
      const backfilled = cloneState(state);
      const { changed } = ensureAlignmentFields(backfilled.transcripts, backfilled.segments);
      if (changed) setState(reconcile(backfilled, { merge: false }));

      // 崩溃恢复：上次合并若停在“已算出结果但尚未确认落盘”，重开时让研究者继续应用或撤回整包
      const checkpoint = await readCheckpoint();
      if (checkpoint && checkpoint.status !== 'committed' && checkpoint.status !== 'rolled-back') {
        setPendingCheckpoint(checkpoint);
      } else if (checkpoint) {
        await clearCheckpoint();
      }
    } finally {
      setStorageReady(true);
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

  const orderedThemes = () => buildTreeOrder(state.themes);

  // —————————————— 离线编码包 ——————————————

  /** 为指定编码员导出离线编码包（含原文指纹、来源键与下发基线） */
  const exportCodingPackage = (coder: CoderId, note?: string) => {
    const pack = buildPackage(cloneState(state), coder, note);
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `离线编码包-${coder}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /** 读入编码包并预演合并，返回计划供界面审阅；非法/旧包返回错误文案或迁移清单 */
  const previewPackage = async (raw: string): Promise<{ ok: true; plan: MergePlan; pkg: CodingPackage } | { ok: false; error: string }> => {
    const parsed = parsePackage(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const plan = prepareMerge(cloneState(state), parsed.pkg);
    return { ok: true, plan, pkg: parsed.pkg };
  };

  /** 重新预演（研究者调整手工对齐后），保留已做裁决 */
  const repreview = (pkg: CodingPackage, manual: ManualLinks, prior?: MergePlan): MergePlan => {
    const plan = prepareMerge(cloneState(state), pkg, manual);
    if (prior) {
      plan.conflicts.forEach((conflict) => {
        const previous = prior.conflicts.find((item) => item.id === conflict.id && item.resolution !== 'pending');
        if (previous) conflict.resolution = previous.resolution;
      });
      plan.reviews.forEach((review) => {
        const previous = prior.reviews.find((item) => item.id === review.id);
        if (previous) review.acknowledged = previous.acknowledged;
      });
    }
    return plan;
  };

  const resolveConflict = (plan: MergePlan, conflictId: string, resolution: Exclude<ResolutionChoice, 'pending'>) =>
    setConflictResolution(plan, conflictId, resolution);
  const markReview = (plan: MergePlan, reviewId: string, acknowledged: boolean) => acknowledgeReview(plan, reviewId, acknowledged);

  /**
   * 提交合并：先把检查点（合并前快照 + 计划 + 包）原子写入 IndexedDB，
   * 确认持久化成功后才改写内存并触发常规保存；任一步失败都可用检查点整包撤回。
   */
  const commitMerge = async (pkg: CodingPackage, plan: MergePlan): Promise<{ ok: true } | { ok: false; error: string }> => {
    const beforeState = cloneState(state);
    let afterState: CodingState;
    try {
      afterState = applyMerge(beforeState, pkg, plan);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '合并计划存在未解决项。' };
    }

    const checkpoint: MergeCheckpoint = {
      id: `cp-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      package: pkg,
      plan,
      beforeState,
      afterState,
      status: 'applied-pending-write',
      revisionBefore: beforeState.revision,
      revisionAfter: afterState.revision
    };
    try {
      await writeCheckpoint(checkpoint);
    } catch (error) {
      return { ok: false, error: `检查点写入失败，已取消合并，当前库未改动：${error instanceof Error ? error.message : String(error)}` };
    }

    setUndoStack((items) => [...items.slice(-49), beforeState]);
    setRedoStack([]);
    setState(reconcile(afterState, { merge: false }));
    persist(afterState);
    setPendingCheckpoint(checkpoint);

    // 常规持久化（IndexedDB + localStorage）成功后再把检查点标记为 committed；
    // 若在此处崩溃/断电，重开时检查点仍是 applied-pending-write，可继续应用或撤回。
    window.setTimeout(() => {
      void writeEnvelope({
        revision: afterState.revision,
        updatedAt: afterState.updatedAt,
        writerId: TAB_ID,
        state: afterState
      })
        .then(() => clearCheckpoint())
        .then(() => setPendingCheckpoint(null))
        .catch((error: unknown) => {
          checkpoint.lastError = error instanceof Error ? error.message : String(error);
          void writeCheckpoint(checkpoint).catch(() => undefined);
        });
    }, 220);
    return { ok: true };
  };

  /** 重开后继续应用：检查点里已有合并后状态，直接重新落盘 */
  const resumeCheckpoint = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const checkpoint = pendingCheckpoint();
    if (!checkpoint?.afterState) return { ok: false, error: '没有可继续的合并检查点。' };
    const afterState = cloneState(checkpoint.afterState);
    try {
      await writeEnvelope({
        revision: afterState.revision,
        updatedAt: afterState.updatedAt,
        writerId: TAB_ID,
        state: afterState
      });
      setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
      setRedoStack([]);
      setState(reconcile(afterState, { merge: false }));
      await clearCheckpoint();
      setPendingCheckpoint(null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `继续应用失败，可改选“撤回整包”：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /** 整包撤回：恢复到检查点记录的合并前状态并落盘清除检查点 */
  const rollbackCheckpoint = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const checkpoint = pendingCheckpoint();
    if (!checkpoint) return { ok: false, error: '没有可撤回的合并检查点。' };
    const restored = rollbackState(cloneState(checkpoint.beforeState));
    try {
      await writeEnvelope({
        revision: restored.revision,
        updatedAt: restored.updatedAt,
        writerId: TAB_ID,
        state: restored
      });
      setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
      setRedoStack([]);
      setState(reconcile(restored, { merge: false }));
      const cleared: MergeCheckpoint = { ...checkpoint, status: 'rolled-back' };
      await writeCheckpoint(cleared);
      await clearCheckpoint();
      setPendingCheckpoint(null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `撤回失败，检查点仍保留可重试：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const dismissCheckpointBanner = () => setPendingCheckpoint(null);

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
    exportCodingPackage,
    previewPackage,
    repreview,
    resolveConflict,
    markReview,
    commitMerge,
    resumeCheckpoint,
    rollbackCheckpoint,
    dismissCheckpointBanner,
    pendingCheckpoint,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt
  };
}
