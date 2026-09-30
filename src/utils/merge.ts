import type {
  CoderId,
  CheckpointHistoryEntry,
  CodingPackage,
  CodingState,
  MergeCheckpoint,
  MergePlan,
  MigrationItem,
  PackagePayload,
  Segment,
  Theme,
  Transcript
} from '../types';

import { deleteCheckpointRecord, readCheckpointRecord, saveCheckpointRecord } from './db';
import { sha256Hex } from './sha256';

/* ================= 指纹 ================= */

const normalizeText = (text: string) =>
  text
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:“”"'‘’（）()【】\[\]…—\-·]/g, '')
    .toLocaleLowerCase('zh-CN');

/**
 * 原文指纹：访谈来源 + 片段原文归一化后的 SHA-256。
 * 同步实现保证旧数据迁移补算与历史指纹完全一致。
 */
export const fingerprintOfSync = (sourceKey: string, text: string): string =>
  sha256Hex(`${sourceKey}\n${normalizeText(text)}`);

/** 异步版本与同步实现结果相同；保留 async 接口便于需要 await 的调用点 */
export const fingerprintOf = async (sourceKey: string, text: string): Promise<string> =>
  fingerprintOfSync(sourceKey, text);

/** 访谈来源键：来源文件名优先，其次 标题|受访者；保证两台机器上同一访谈一致 */
export const sourceKeyOf = (transcript: Pick<Transcript, 'sourceName' | 'title' | 'participant'>): string =>
  `src:${transcript.sourceName?.trim() || `${transcript.title.trim()}|${transcript.participant.trim()}`}`;

/* ================= 主题路径 ================= */

const themeIndex = (themes: Theme[]) => {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const pathOf = (theme: Theme): string => {
    const names: string[] = [];
    let current: Theme | undefined = theme;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      names.unshift(current.name.trim());
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(' / ');
  };
  return {
    byId,
    pathOf,
    pathById: new Map(themes.map((theme) => [theme.id, pathOf(theme)] as const))
  };
};

/* ================= 迁移清单 ================= */

/**
 * 为缺少指纹的旧数据补算，返回迁移项。
 * 迁移项在补算前判定、补算后仍保留，供合并界面展示“本次对齐补算了哪些指纹”。
 */
export const buildMigration = async (
  transcripts: Transcript[],
  segments: Segment[]
): Promise<MigrationItem[]> => {
  const items: MigrationItem[] = [];
  const transcriptById = new Map(transcripts.map((item) => [item.id, item]));

  const missingSource = new Set<string>();
  for (const transcript of transcripts) {
    if (!transcript.sourceKey) {
      missingSource.add(transcript.id);
      items.push({
        kind: 'transcript',
        ref: transcript.id,
        detail: `访谈《${transcript.title}》缺少来源指纹（sourceKey），将按来源名“${transcript.sourceName || `${transcript.title}|${transcript.participant}`}”补算`,
        backfilled: true
      });
    }
  }

  for (const segment of segments) {
    const hadFingerprint = Boolean(segment.fingerprint);
    const transcript = transcriptById.get(segment.transcriptId);
    if (!transcript) {
      items.push({ kind: 'segment', ref: segment.id, detail: `片段 #${segment.order + 1} 找不到所属访谈，无法补算指纹`, backfilled: false });
      continue;
    }
    const key = transcript.sourceKey ?? sourceKeyOf(transcript);
    if (!hadFingerprint) {
      items.push({
        kind: 'segment',
        ref: segment.id,
        detail: `《${transcript.title}》#${segment.order + 1} ${segment.time} 缺少原文指纹，将按原文补算 SHA-256`,
        backfilled: true
      });
      segment.fingerprint = await fingerprintOf(key, segment.text);
    }
  }

  transcripts.forEach((transcript) => { if (missingSource.has(transcript.id)) transcript.sourceKey = sourceKeyOf(transcript); });
  return items;
};

/* ================= 工作包 ================= */

const payloadFromState = (state: CodingState): PackagePayload => ({
  revision: state.revision,
  updatedAt: state.updatedAt,
  coderA: state.coderA,
  coderB: state.coderB,
  transcripts: structuredClone(state.transcripts),
  segments: structuredClone(state.segments),
  themes: structuredClone(state.themes)
});

export const issuePackage = async (state: CodingState, coderName: string): Promise<CodingPackage> => {
  const [transcripts, segments] = [structuredClone(state.transcripts), structuredClone(state.segments)];
  await buildMigration(transcripts, segments);
  const payload = payloadFromState({ ...state, transcripts, segments });
  return {
    kind: 'coding-package',
    packageVersion: 1,
    issuedAt: new Date().toISOString(),
    coderName: coderName.trim() || undefined,
    base: payload,
    work: structuredClone(payload)
  };
};

export const downloadPackage = (pkg: CodingPackage, fileName?: string) => {
  const name = fileName ?? `离线编码包-${(pkg.coderName ?? '编码员')}-${pkg.issuedAt.slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const parsePackage = (raw: string): CodingPackage => {
  const data = JSON.parse(raw) as CodingPackage;
  if (!data || data.kind !== 'coding-package' || !data.work || !Array.isArray(data.work.segments) || !Array.isArray(data.work.themes)) {
    throw new Error('文件不是有效的离线编码包');
  }
  return data;
};

/* ================= 合并计划 ================= */

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));

/**
 * 构建合并计划（不修改本地状态）：
 * - 片段按 访谈来源(sourceKey) + 原文指纹 对齐；
 * - 主题按 主题路径 对齐，本地没有的路径登记为待新建；
 * - 判断按 base/work/local 三方合并，仅同一编码员在同一项目上两边改动且结果不同才记冲突。
 */
export const buildMergePlan = async (local: CodingState, pkg: CodingPackage): Promise<MergePlan> => {
  const work = structuredClone(pkg.work);
  const base = pkg.base ? structuredClone(pkg.base) : null;

  const migration = await buildMigration(work.transcripts, work.segments);
  if (base) await buildMigration(base.transcripts, base.segments);

  const localIdx = themeIndex(local.themes);
  const workIdx = themeIndex(work.themes);
  const baseIdx = base ? themeIndex(base.themes) : null;

  /* ---- 主题按路径对齐 ---- */
  const byPackageId: Record<string, string> = {};
  const byPath: Record<string, string> = {};
  const createdPaths: string[] = [];
  const metadataDiverged: string[] = [];
  const createdThemes: MergePlan['createdThemes'] = [];

  // 先登记本地全部路径
  local.themes.forEach((theme) => { byPath[localIdx.pathById.get(theme.id)!] = theme.id; });

  // 按路径深度排序，保证父主题先建
  const workByPath = new Map<string, Theme>();
  work.themes.forEach((theme) => workByPath.set(workIdx.pathById.get(theme.id)!, theme));
  const sortedPaths = [...workByPath.keys()].sort((a, b) => a.split(' / ').length - b.split(' / ').length || a.localeCompare(b, 'zh-CN'));

  sortedPaths.forEach((path) => {
    const workTheme = workByPath.get(path)!;
    const existingId = byPath[path];
    if (existingId) {
      byPackageId[workTheme.id] = existingId;
      const localTheme = localIdx.byId.get(existingId)!;
      if (localTheme.definition !== workTheme.definition || localTheme.memo !== workTheme.memo
        || JSON.stringify(localTheme.examples) !== JSON.stringify(workTheme.examples)) {
        metadataDiverged.push(path);
      }
      return;
    }
    const id = `t-${crypto.randomUUID()}`;
    const parentPath = path.includes(' / ') ? path.slice(0, path.lastIndexOf(' / ')) : null;
    const newTheme: Theme = {
      ...workTheme,
      id,
      parentId: parentPath ? (byPath[parentPath] ?? createdThemes.find((item) => item.path === parentPath)?.id ?? null) : null,
      examples: [...workTheme.examples]
    };
    byPath[path] = id;
    byPackageId[workTheme.id] = id;
    createdPaths.push(path);
    createdThemes.push({ id, path, name: workTheme.name, parentPath, theme: newTheme });
  });

  const localIdOfWork = (workThemeId: string): string | null => byPackageId[workThemeId] ?? null;
  const localIdOfBase = (baseThemeId: string): string | null => {
    if (!baseIdx) return null;
    const path = baseIdx.pathById.get(baseThemeId);
    return path ? byPath[path] ?? null : null;
  };

  // 本地片段指纹索引
  const localTranscriptByKey = new Map(local.transcripts.map((item) => [item.sourceKey ?? sourceKeyOf(item), item]));
  const localSegmentByFp = new Map<string, Segment>();
  local.segments.forEach((segment) => {
    if (segment.fingerprint) localSegmentByFp.set(segment.fingerprint, segment);
  });

  const unknownSource: string[] = [];
  const unmatched: string[] = [];
  const conflicts: MergePlan['conflicts'] = [];
  const segmentMerges: MergePlan['segmentMerges'] = [];
  const newTranscripts: Transcript[] = [];
  const newTranscriptByKey = new Map<string, Transcript>();
  const warnings: string[] = [];

  const coderNames: MergePlan['coderNames'] = {};
  for (const workSegment of work.segments) {
    const workTranscript = work.transcripts.find((item) => item.id === workSegment.transcriptId);
    const sourceKey = workTranscript?.sourceKey ?? '';
    const sourceLabel = workTranscript?.title ?? '未知访谈';

    let localTranscript = sourceKey ? localTranscriptByKey.get(sourceKey) : undefined;
    let isNewTranscript = false;
    if (!localTranscript && workTranscript) {
      isNewTranscript = true;
      let created = newTranscriptByKey.get(sourceKey);
      if (!created) {
        created = { ...structuredClone(workTranscript), id: `tr-${crypto.randomUUID()}`, sourceKey };
        newTranscriptByKey.set(sourceKey, created);
        newTranscripts.push(created);
        localTranscriptByKey.set(sourceKey, created as Transcript);
      }
      localTranscript = created;
      warnings.push(`本地缺少访谈《${sourceLabel}》，将随包一并新建`);
    }
    if (!workTranscript || (!localTranscript && !isNewTranscript)) {
      unknownSource.push(workSegment.id);
      continue;
    }

    const fingerprint = workSegment.fingerprint ?? fingerprintOfSync(sourceKey, workSegment.text);
    const localSegment = isNewTranscript ? undefined : localSegmentByFp.get(fingerprint);

    if (!isNewTranscript && !localSegment) {
      unmatched.push(workSegment.id);
      continue;
    }

    const baseSegment = base?.segments.find((item) => {
      const tr = base!.transcripts.find((t) => t.id === item.transcriptId);
      return (tr?.sourceKey ?? (tr ? sourceKeyOf(tr) : '')) === sourceKey
        && (item.fingerprint === fingerprint || fingerprintOfSync(tr?.sourceKey ?? sourceKey, item.text) === fingerprint);
    });

    const toPaths = (ids: string[] | undefined, from: 'work' | 'base'): string[] => {
      if (!ids) return [];
      const idx = from === 'work' ? workIdx : baseIdx!;
      return ids.map((id) => idx.pathById.get(id)).filter((path): path is string => Boolean(path));
    };
    const localPathsOf = (segment: Segment) => (['A', 'B'] as CoderId[]).flatMap((coder) =>
      segment.assignments[coder].map((id) => localIdx.pathById.get(id)).filter((p): p is string => Boolean(p)));

    const result: Record<CoderId, string[] | null> = { A: null, B: null };
    const changed: CoderId[] = [];

    (['A', 'B'] as CoderId[]).forEach((coder) => {
      const incomingIds = workSegment.assignments[coder];
      const incomingPaths = toPaths(incomingIds, 'work');
      const incomingLocalIds = incomingIds.map(localIdOfWork).filter((id): id is string => Boolean(id));

      if (!localSegment) {
        // 新访谈的片段：本地不存在，带回的判断即为该编码员的结果
        result[coder] = incomingLocalIds;
        if (incomingLocalIds.length) changed.push(coder);
        return;
      }

      const localIds = localSegment.assignments[coder];
      const baseIds = baseSegment?.assignments[coder];

      if (!baseSegment || !baseIds) {
        // 旧数据包无 base：无法做三方比较。仅当本地该项为空时采用带回内容，否则记为待研究者确认
        if (sameSet(localIds, incomingLocalIds)) return;
        if (localIds.length === 0 && incomingLocalIds.length > 0) {
          result[coder] = incomingLocalIds;
          changed.push(coder);
        } else {
          conflicts.push({
            kind: 'assignment', coder,
            packageSegmentId: workSegment.id, localSegmentId: localSegment.id,
            sourceLabel, time: workSegment.time, speaker: workSegment.speaker, text: workSegment.text,
            basePaths: [], localPaths: localPathsOf(localSegment).filter((p, i, arr) => arr.indexOf(p) === i),
            incomingPaths: [...new Set(incomingPaths)]
          });
        }
        return;
      }

      const baseLocalIds = baseIds.map(localIdOfBase).filter((id): id is string => Boolean(id));
      const incomingChanged = !sameSet(baseLocalIds, incomingLocalIds);
      const localChanged = !sameSet(baseLocalIds, localIds);

      if (!incomingChanged) return;            // 编码员没动这一项
      if (!localChanged || sameSet(localIds, incomingLocalIds)) {
        // 只有编码员改，或两边改成相同结果
        result[coder] = incomingLocalIds;
        changed.push(coder);
        return;
      }
      // 同一编码员改动同一项且内容不同 → 停下等裁决
      conflicts.push({
        kind: 'assignment', coder,
        packageSegmentId: workSegment.id, localSegmentId: localSegment.id,
        sourceLabel, time: workSegment.time, speaker: workSegment.speaker, text: workSegment.text,
        basePaths: [...new Set(toPaths(baseIds, 'base'))],
        localPaths: [...new Set(localPathsOf(localSegment))],
        incomingPaths: [...new Set(incomingPaths)]
      });
    });

    // 新访谈片段一律登记（即使尚未编码，也要随访谈落库）
    if (isNewTranscript || changed.length || workSegment.note) {
      segmentMerges.push({
        packageSegmentId: workSegment.id,
        localSegmentId: localSegment?.id ?? null,
        sourceKey, sourceLabel,
        order: workSegment.order,
        time: workSegment.time, speaker: workSegment.speaker, text: workSegment.text, fingerprint,
        noteIncoming: workSegment.note || undefined,
        isNewTranscript, result, changed
      });
    }
  }

  // 判定工作包主要归属的编码员：比较 work 与 base 中谁的判断变化更多
  if (base) {
    let touched: Record<CoderId, number> = { A: 0, B: 0 };
    work.segments.forEach((workSegment) => {
      const baseSegment = base!.segments.find((item) => item.id === workSegment.id);
      if (!baseSegment) return;
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        if (!sameSet(baseSegment.assignments[coder], workSegment.assignments[coder])) touched[coder] += 1;
      });
    });
    if (touched.A > touched.B) coderNames.A = pkg.coderName ?? work.coderA;
    else if (touched.B > touched.A) coderNames.B = pkg.coderName ?? work.coderB;
  }

  return {
    pkg,
    themeMapping: { byPackageId, byPath, createdPaths, metadataDiverged },
    segmentMapping: {
      byPackageId: Object.fromEntries(segmentMerges.filter((m) => m.localSegmentId).map((m) => [m.packageSegmentId, m.localSegmentId!])),
      unknownSource,
      unmatched
    },
    conflicts,
    segmentMerges,
    newTranscripts,
    createdThemes,
    warnings: [...new Set(warnings)],
    migration,
    hasBase: Boolean(base),
    coderNames
  };
};

/* ================= 检查点 ================= */

const CHECKPOINT_HISTORY_KEY = 'sologsb-1019-checkpoint-history-v1';

const readHistory = (): CheckpointHistoryEntry[] => {
  try {
    const raw = localStorage.getItem(CHECKPOINT_HISTORY_KEY);
    if (raw) return JSON.parse(raw) as CheckpointHistoryEntry[];
  } catch {
    localStorage.removeItem(CHECKPOINT_HISTORY_KEY);
  }
  return [];
};

const writeHistory = (history: CheckpointHistoryEntry[]) => {
  localStorage.setItem(CHECKPOINT_HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
};

/** 完整检查点（含 before/plan）写入 IndexedDB；应用失败后可据此恢复 */
export const saveCheckpoint = async (checkpoint: MergeCheckpoint) => {
  await saveCheckpointRecord(checkpoint);
};

export const loadPendingCheckpoint = async (): Promise<MergeCheckpoint | null> => readCheckpointRecord();

export const clearPendingCheckpoint = async (appliedCounts: CheckpointHistoryEntry['appliedCounts']) => {
  const pending = await readCheckpointRecord();
  if (pending) {
    const { before: _before, plan: _plan, ...summary } = pending;
    writeHistory([{ ...summary, appliedAt: new Date().toISOString(), appliedCounts }, ...readHistory()]);
    await deleteCheckpointRecord();
  }
};

export const markCheckpointRolledBack = async () => {
  const pending = await readCheckpointRecord();
  if (pending) {
    const { before: _before, plan: _plan, ...summary } = pending;
    writeHistory([{ ...summary, rolledBackAt: new Date().toISOString(), appliedCounts: { themes: 0, transcripts: 0, segments: 0, judgments: 0 } }, ...readHistory()]);
    await deleteCheckpointRecord();
  }
};

/** 未应用即取消：丢弃待处理检查点，保留已完成历史 */
export const discardPendingCheckpoint = async () => {
  if (await readCheckpointRecord()) await deleteCheckpointRecord();
};

export const listCheckpointHistory = (): CheckpointHistoryEntry[] => readHistory();

export const summarizePackage = (pkg: CodingPackage): string => {
  const coded = pkg.work.segments.filter((segment) => segment.assignments.A.length || segment.assignments.B.length).length;
  return `${pkg.coderName ?? '匿名编码员'} · ${pkg.work.transcripts.length} 份访谈 / ${pkg.work.segments.length} 个片段 / ${coded} 段已编码`;
};

/* ================= 应用计划 ================= */

export interface AppliedCounts {
  themes: number;
  transcripts: number;
  segments: number;
  judgments: number;
}

/**
 * 把已确认（冲突均已裁决）的合并计划应用到草稿上。
 * 调用方必须保证所有 conflicts 都带 resolution；未裁决项一律跳过（保守不写）。
 */
export const applyMergeToDraft = (draft: CodingState, plan: MergePlan): AppliedCounts => {
  const counts: AppliedCounts = { themes: 0, transcripts: 0, segments: 0, judgments: 0 };

  // 1. 按路径新建主题（createdThemes 已按父先子后排序）
  plan.createdThemes.forEach(({ theme }) => {
    if (draft.themes.some((item) => item.id === theme.id)) return;
    draft.themes.push(structuredClone(theme));
    counts.themes += 1;
  });

  // 2. 主题元数据：本地优先；本地为空时采用工作包内容；示例取并集
  const workIdx = themeIndex(plan.pkg.work.themes);
  const workThemeByPath = new Map<string, Theme>();
  plan.pkg.work.themes.forEach((theme) => workThemeByPath.set(workIdx.pathById.get(theme.id)!, theme));
  plan.themeMapping.metadataDiverged.forEach((path) => {
    const localId = plan.themeMapping.byPath[path];
    const localTheme = draft.themes.find((item) => item.id === localId);
    const incoming = workThemeByPath.get(path);
    if (!localTheme || !incoming) return;
    if (!localTheme.definition && incoming.definition) localTheme.definition = incoming.definition;
    if (!localTheme.memo && incoming.memo) localTheme.memo = incoming.memo;
    incoming.examples.forEach((example) => { if (!localTheme.examples.includes(example)) localTheme.examples.push(example); });
  });

  // 3. 新建访谈（id 在计划阶段已生成）
  const localTranscriptByKey = new Map(draft.transcripts.map((item) => [item.sourceKey ?? sourceKeyOf(item), item]));
  plan.newTranscripts.forEach((transcript) => {
    const key = transcript.sourceKey!;
    if (!localTranscriptByKey.has(key)) {
      draft.transcripts.push(structuredClone(transcript));
      localTranscriptByKey.set(key, transcript);
      counts.transcripts += 1;
    }
  });

  // 4. 已存在片段：应用三方合并结果与冲突裁决
  const segmentById = new Map(draft.segments.map((item) => [item.id, item]));
  plan.segmentMerges.forEach((merge) => {
    if (merge.isNewTranscript || !merge.localSegmentId) return;
    const segment = segmentById.get(merge.localSegmentId);
    if (!segment) return;
    (['A', 'B'] as CoderId[]).forEach((coder) => {
      const resolved = merge.result[coder];
      if (resolved) {
        segment.assignments[coder] = [...resolved];
        counts.judgments += 1;
      }
    });
    if (!segment.note && merge.noteIncoming) segment.note = merge.noteIncoming;
  });

  // 冲突裁决（同一位编码员两边改了同一项）：按研究者选择覆盖
  plan.conflicts.forEach((conflict) => {
    if (conflict.resolution !== 'incoming') return;
    const segment = segmentById.get(conflict.localSegmentId);
    if (!segment) return;
    segment.assignments[conflict.coder] = conflict.incomingPaths
      .map((path) => plan.themeMapping.byPath[path])
      .filter((id): id is string => Boolean(id));
    counts.judgments += 1;
  });

  // 5. 新访谈的片段：按工作包顺序整体落库
  const newMerges = plan.segmentMerges
    .filter((merge) => merge.isNewTranscript)
    .sort((a, b) => a.order - b.order);
  let offset = draft.segments.length;
  newMerges.forEach((merge) => {
    const transcript = localTranscriptByKey.get(merge.sourceKey);
    if (!transcript) return;
    draft.segments.push({
      id: `s-${crypto.randomUUID()}`,
      transcriptId: transcript.id,
      order: offset++,
      speaker: merge.speaker,
      time: merge.time,
      text: merge.text,
      fingerprint: merge.fingerprint,
      assignments: {
        A: merge.result.A ?? [],
        B: merge.result.B ?? []
      },
      note: merge.noteIncoming ?? ''
    });
    counts.segments += 1;
    counts.judgments += (merge.result.A ? 1 : 0) + (merge.result.B ? 1 : 0);
  });

  return counts;
};

export const unresolvedConflictCount = (plan: MergePlan): number =>
  plan.conflicts.filter((conflict) => !conflict.resolution).length;
