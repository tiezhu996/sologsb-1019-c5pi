import type { CoderId, CodingState, Segment, Theme, Transcript } from '../types';
import {
  FUZZY_SUGGEST,
  ensureAlignmentFields,
  fingerprintOf,
  normalizeText,
  textSimilarity,
  transcriptSourceKey
} from './fingerprint';
import {
  PACKAGE_KIND,
  type CodingPackage,
  type MergeConflict,
  type MergePlan,
  type MergeReview,
  type MigrationItem,
  type PackageBaseSnapshot,
  type ResolutionChoice,
  type SegmentMapping,
  type ThemeMapping
} from './types';

const PATH_SEP = ' / ';
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const clone = <T>(value: T): T => structuredClone(value);
const sortedPaths = (paths: string[]): string[] => [...new Set(paths)].sort();
const eqPaths = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const unionPaths = (a: string[], b: string[]) => sortedPaths([...a, ...b]);

/** 主题 id → 完整路径（名称序列，根 → 叶） */
export function themePathMap(themes: Theme[]): Map<string, string> {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const cache = new Map<string, string>();
  const pathOf = (id: string, guard: Set<string> = new Set()): string => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const theme = byId.get(id);
    if (!theme || guard.has(id)) return '';
    guard.add(id);
    const path = theme.parentId ? [pathOf(theme.parentId, guard), theme.name].filter(Boolean).join(PATH_SEP) : theme.name;
    cache.set(id, path);
    return path;
  };
  const result = new Map<string, string>();
  themes.forEach((theme) => result.set(theme.id, pathOf(theme.id)));
  return result;
}

/** 构造离线下发包：state 全量快照 + 下发时刻基线，基线判断统一记为主题路径以免疫两端编号差异 */
export function buildPackage(state: CodingState, coder: CoderId, note?: string): CodingPackage {
  const paths = themePathMap(state.themes);
  const segmentAssignments: Record<string, Record<CoderId, string[]>> = {};
  state.segments.forEach((segment) => {
    segmentAssignments[segment.id] = {
      A: sortedPaths(segment.assignments.A.map((id) => paths.get(id) ?? '').filter(Boolean)),
      B: sortedPaths(segment.assignments.B.map((id) => paths.get(id) ?? '').filter(Boolean))
    };
  });
  const segmentNotes: Record<string, string> = {};
  state.segments.forEach((segment) => { segmentNotes[segment.id] = segment.note; });
  const themes: PackageBaseSnapshot['themes'] = {};
  state.themes.forEach((theme) => { themes[theme.id] = { definition: theme.definition, memo: theme.memo, examples: [...theme.examples] }; });

  const snapshot = clone(state);
  ensureAlignmentFields(snapshot.transcripts, snapshot.segments);
  return {
    kind: PACKAGE_KIND,
    packageVersion: 1,
    exportedAt: new Date().toISOString(),
    coder,
    coderName: coder === 'A' ? state.coderA : state.coderB,
    state: snapshot,
    base: { revision: state.revision, updatedAt: state.updatedAt, coderA: state.coderA, coderB: state.coderB, segmentAssignments, segmentNotes, themes },
    note
  };
}

export function parsePackage(raw: string): { ok: true; pkg: CodingPackage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '文件不是合法 JSON。' };
  }
  const candidate = parsed as Partial<CodingPackage> | null;
  if (!candidate || typeof candidate !== 'object') return { ok: false, error: '文件内容为空或格式不正确。' };
  if (candidate.kind !== PACKAGE_KIND) {
    return {
      ok: false,
      error: '这不是离线编码包（缺少类型标记）。若它是旧版“完整导出 JSON”，请先在旧版本补导出指纹与基线，或按迁移清单手工处理。'
    };
  }
  if (!candidate.state || !Array.isArray(candidate.state.segments) || !Array.isArray(candidate.state.themes)) {
    return { ok: false, error: '编码包缺少 state.segments / state.themes，无法合并。' };
  }
  if (candidate.coder !== 'A' && candidate.coder !== 'B') {
    return { ok: false, error: '编码包未标明由哪位编码员完成（coder 应为 A 或 B）。' };
  }
  return { ok: true, pkg: candidate as CodingPackage };
}

interface Triple {
  base: string[] | null;
  local: string[];
  pkg: string[];
}

/** 把主题 id 序列翻译成排序去重后的主题路径；未知 id 记录迁移项并忽略 */
function toPaths(
  ids: string[],
  map: Map<string, string>,
  side: 'local' | 'pkg',
  migration?: MigrationItem[]
): string[] {
  const result: string[] = [];
  ids.forEach((id) => {
    const path = map.get(id);
    if (path === undefined || path === '') {
      if (side === 'pkg' && migration && !migration.some((item) => item.code === 'unknown-theme-reference' && item.message.includes(id))) {
        migration.push({ code: 'unknown-theme-reference', level: 'warning', message: `离线包引用了包内不存在的主题（${id}），该引用已忽略。` });
      }
      return;
    }
    result.push(path);
  });
  return sortedPaths(result);
}

/** 研究者手工指定的片段对齐：包片段 id → 本地片段 id；显式 null 表示确认这是新增片段 */
export type ManualLinks = Record<string, string | null>;

/**
 * 预演合并，产出可审阅、可持久化的合并计划。不修改入参。
 * 对齐顺序：访谈来源(sourceKey) → 片段指纹(fingerprint，旧包退化 fuzzy 建议) → 主题路径。
 * 手工对齐通过 manual 传入，可在同一函数上反复重跑；冲突 id 稳定，重跑不丢失已做裁决。
 */
export function prepareMerge(localRaw: CodingState, pkg: CodingPackage, manual: ManualLinks = {}): MergePlan {
  const local = ensureReady(localRaw);
  const remote = ensureReady(pkg.state);
  const migration: MigrationItem[] = [];
  const reviews: MergeReview[] = [];

  if (!pkg.base) {
    migration.push({
      code: 'legacy-no-base', level: 'warning',
      message: '该数据包缺少下发基线快照，无法判断每一项由谁改动。',
      detail: '判断将按“并集 / 保留本地”的保守方式预合并，并逐条列入复核清单，请研究者确认后再提交。'
    });
  }
  const pkgMissingFp = pkg.state.segments.filter((segment: Segment) => !segment.fingerprint).length;
  if (pkgMissingFp > 0) {
    migration.push({
      code: 'legacy-no-fingerprint', level: 'warning',
      message: `数据包中有 ${pkgMissingFp} 个片段缺少原文指纹（旧版数据）。`,
      detail: '已按归一化原文重新计算：文本完全一致按指纹精确对齐；仅有口误/标点差异的给出相似度建议需确认；仍无法确认的片段暂停而不是自动建成重复片段。'
    });
  }

  // —— 主题：按路径对齐 ——
  const localPaths = themePathMap(local.themes);
  const pkgPaths = themePathMap(remote.themes);
  const localByPath = new Map<string, string>();
  localPaths.forEach((path, id) => { if (!localByPath.has(path)) localByPath.set(path, id); });
  const themeMappings: ThemeMapping[] = [];
  pkgPaths.forEach((path, pkgId) => {
    const localId = localByPath.get(path) ?? null;
    themeMappings.push({ path, localId, packageId: pkgId, kind: localId ? 'fingerprint' : 'new' });
  });

  // —— 访谈：按来源键对齐 ——
  const localTranscriptByKey = new Map<string, Transcript>();
  local.transcripts.forEach((transcript) => localTranscriptByKey.set(transcript.sourceKey!, transcript));
  const transcriptMappings = remote.transcripts.map((transcript) => ({
    localId: localTranscriptByKey.get(transcript.sourceKey!)?.id ?? null,
    packageId: transcript.id,
    sourceKey: transcript.sourceKey!,
    title: transcript.title,
    kind: (localTranscriptByKey.has(transcript.sourceKey!) ? 'fingerprint' : 'new') as 'fingerprint' | 'new'
  }));
  const transcriptLocalId = new Map(transcriptMappings.map((item) => [item.packageId, item.localId]));

  // —— 片段 ——
  const localByTranscript = new Map<string, Segment[]>();
  local.segments.forEach((segment) => localByTranscript.set(segment.transcriptId, [...(localByTranscript.get(segment.transcriptId) ?? []), segment]));
  const segmentMappings: SegmentMapping[] = [];
  const reportedDrift = new Set<string>();

  remote.transcripts.forEach((transcript) => {
    const localTranscriptId = transcriptLocalId.get(transcript.id);
    const candidates = localTranscriptId ? [...(localByTranscript.get(localTranscriptId) ?? [])] : [];
    const claimed = new Set<string>();
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    // 先统一占用研究者手工指定的本地片段，避免多个包片段被重复指到同一段
    remote.segments
      .filter((segment) => segment.transcriptId === transcript.id)
      .forEach((segment) => {
        const target = manual[segment.id];
        if (target && candidateIds.has(target)) claimed.add(target);
      });

    const alignOne = (segment: Segment): SegmentMapping => {
      const common = {
        packageId: segment.id,
        transcriptSourceKey: transcript.sourceKey!,
        order: segment.order,
        speaker: segment.speaker,
        time: segment.time,
        text: segment.text,
        fingerprint: segment.fingerprint!
      };
      if (!localTranscriptId) return { ...common, localId: null, kind: 'new' };

      // 手工对齐优先（可覆盖 fuzzy 建议）
      if (Object.prototype.hasOwnProperty.call(manual, segment.id)) {
        const target = manual[segment.id];
        if (target === null) return { ...common, localId: null, kind: 'new' };
        if (candidates.some((candidate) => candidate.id === target)) {
          claimed.add(target);
          return { ...common, localId: target, kind: 'manual' };
        }
      }
      const exact = candidates.find((candidate) => !claimed.has(candidate.id) && candidate.fingerprint === segment.fingerprint);
      if (exact) {
        claimed.add(exact.id);
        return { ...common, localId: exact.id, kind: 'fingerprint' };
      }
      let bestSegment: Segment | null = null;
      let bestScore = -1;
      for (const candidate of candidates) {
        if (claimed.has(candidate.id)) continue;
        const score = textSimilarity(segment.text, candidate.text);
        if (score > bestScore) { bestScore = score; bestSegment = candidate; }
      }
      if (bestSegment && bestScore >= FUZZY_SUGGEST) {
        claimed.add(bestSegment.id);
        const driftKey = `${segment.id}:${bestSegment.id}`;
        if (!reportedDrift.has(driftKey)) {
          reportedDrift.add(driftKey);
          migration.push({
            code: 'segment-text-drift', level: 'warning',
            message: `片段疑似同一段但原文有出入（相似度 ${Math.round(bestScore * 100)}%）：${transcript.title} @ ${segment.time}`,
            detail: `离线包：${normalizeText(segment.text).slice(0, 80)}…\n本地库：${normalizeText(bestSegment.text).slice(0, 80)}…`
          });
        }
        return { ...common, localId: bestSegment.id, kind: 'fuzzy', similarity: bestScore };
      }
      return { ...common, localId: null, kind: 'unmatched' };
    };

    remote.segments
      .filter((segment) => segment.transcriptId === transcript.id)
      .sort((a, b) => a.order - b.order)
      .forEach((segment) => segmentMappings.push(alignOne(segment)));
  });

  const conflicts: MergeConflict[] = [];
  const pushReview = (id: string, review: Omit<MergeReview, 'id' | 'acknowledged'>) =>
    reviews.push({ id, acknowledged: false, ...review });

  const counts: MergePlan['counts'] = {
    transcripts: {
      matched: transcriptMappings.filter((item) => item.localId).length,
      newCount: transcriptMappings.filter((item) => !item.localId).length
    },
    segments: { fingerprint: 0, fuzzy: 0, manual: 0, newCount: 0, unmatched: 0 },
    themes: {
      matched: themeMappings.filter((item) => item.localId).length,
      created: themeMappings.filter((item) => !item.localId).length
    },
    assignments: { added: 0, removed: 0, unchanged: 0, conflicts: 0 },
    themeFields: { updated: 0, conflicts: 0 },
    notes: { updated: 0, conflicts: 0 }
  };
  segmentMappings.forEach((mapping) => {
    counts.segments[mapping.kind === 'new' ? 'newCount' : mapping.kind === 'fingerprint' ? 'fingerprint' : mapping.kind === 'fuzzy' ? 'fuzzy' : mapping.kind === 'manual' ? 'manual' : 'unmatched'] += 1;
  });

  // —— 判断合并（仅离线编码员那一列）——
  segmentMappings.forEach((mapping) => {
    if (mapping.kind === 'unmatched') return;
    const pkgSegment = remote.segments.find((segment) => segment.id === mapping.packageId)!;
    const localSegment = mapping.localId ? local.segments.find((segment) => segment.id === mapping.localId) : null;
    const pkgVal = toPaths(pkgSegment.assignments[pkg.coder], pkgPaths, 'pkg', migration);
    const localVal = localSegment ? toPaths(localSegment.assignments[pkg.coder], localPaths, 'local', migration) : [];
    // 基线在打包时已统一存为主题路径，直接使用（不能再当主题 id 反查）
    const baseVal = pkg.base ? sortedPaths(pkg.base.segmentAssignments[mapping.packageId!]?.[pkg.coder] ?? []) : null;
    const triple: Triple = { base: baseVal, local: localVal, pkg: pkgVal };
    const segmentRef = () => ({
      packageId: mapping.packageId!,
      localId: mapping.localId,
      transcriptSourceKey: mapping.transcriptSourceKey,
      time: mapping.time,
      speaker: mapping.speaker,
      text: mapping.text
    });

    if (!localSegment) {
      if (triple.pkg.length) counts.assignments.added += triple.pkg.length;
      return;
    }

    if (triple.base === null) {
      if (!eqPaths(triple.local, triple.pkg)) {
        const proposed = unionPaths(triple.local, triple.pkg);
        counts.assignments.added += proposed.filter((path) => !triple.local.includes(path)).length;
        pushReview(`legacy-assign:${mapping.packageId}`, {
          level: 'warning',
          code: 'legacy-assignment',
          message: `旧包缺基线：${pkg.coderName} 在片段（${mapping.time} · ${mapping.speaker}）的判断无法与本地改动区分，已按并集预合并。`,
          detail: `本地：${triple.local.join(' | ') || '（空）'}\n离线包：${triple.pkg.join(' | ') || '（空）'}\n预合并：${proposed.join(' | ') || '（空）'}`,
          segment: { time: mapping.time, speaker: mapping.speaker, text: mapping.text }
        });
      } else {
        counts.assignments.unchanged += 1;
      }
      return;
    }

    const pkgChanged = !eqPaths(triple.base, triple.pkg);
    const localChanged = !eqPaths(triple.base, triple.local);
    if (!pkgChanged) { counts.assignments.unchanged += 1; return; }
    if (!localChanged) {
      counts.assignments.added += triple.pkg.filter((path) => !triple.local.includes(path)).length;
      counts.assignments.removed += triple.local.filter((path) => !triple.pkg.includes(path)).length;
      return;
    }
    if (eqPaths(triple.local, triple.pkg)) { counts.assignments.unchanged += 1; return; }

    // 同一位编码员改动同一项且内容不同 → 停下等待裁决
    conflicts.push({
      id: `assign:${mapping.packageId}:${pkg.coder}`,
      field: { type: 'assignment', coder: pkg.coder },
      segment: segmentRef(),
      baseValue: triple.base,
      localValue: triple.local,
      packageValue: triple.pkg,
      resolution: 'pending'
    });
    counts.assignments.conflicts += 1;
  });

  // —— 主题字段 ——
  themeMappings.forEach((mapping) => {
    if (!mapping.localId) return;
    const localTheme = local.themes.find((theme) => theme.id === mapping.localId)!;
    const pkgTheme = remote.themes.find((theme) => theme.id === mapping.packageId)!;
    const baseTheme = pkg.base?.themes[mapping.packageId!];
    (['definition', 'memo'] as const).forEach((fieldName) => {
      const baseVal = baseTheme?.[fieldName] ?? null;
      const localVal = localTheme[fieldName];
      const pkgVal = pkgTheme[fieldName];
      if (localVal === pkgVal) return;
      if (baseVal === null) {
        pushReview(`legacy-theme:${mapping.path}:${fieldName}`, {
          level: 'warning',
          code: 'legacy-theme-field',
          message: `旧包缺基线：主题「${mapping.path}」的${fieldName === 'definition' ? '定义' : '备忘录'}在两边不同，默认保留本地，请复核。`,
          detail: `本地：${localVal || '（空）'}\n离线包：${pkgVal || '（空）'}`
        });
        return;
      }
      if (baseVal === pkgVal || baseVal === localVal) {
        if (baseVal !== pkgVal) counts.themeFields.updated += 1;
        return;
      }
      conflicts.push({
        id: `theme:${mapping.path}:${fieldName}`,
        field: { type: 'themeField', field: fieldName, path: mapping.path },
        baseValue: [baseVal],
        localValue: [localVal],
        packageValue: [pkgVal],
        resolution: 'pending'
      });
      counts.themeFields.conflicts += 1;
    });
    const baseExamples = baseTheme?.examples ?? null;
    const pkgAdded = pkgTheme.examples.filter((example) => !localTheme.examples.includes(example) && (baseExamples === null || !baseExamples.includes(example)));
    if (pkgAdded.length) counts.themeFields.updated += 1;
  });

  // —— 片段备注 ——
  segmentMappings.forEach((mapping) => {
    if (mapping.kind === 'unmatched' || !mapping.localId) return;
    const localSegment = local.segments.find((segment) => segment.id === mapping.localId)!;
    const pkgSegment = remote.segments.find((segment) => segment.id === mapping.packageId)!;
    const baseNote = pkg.base?.segmentNotes[mapping.packageId!] ?? null;
    if (localSegment.note === pkgSegment.note) return;
    if (baseNote === null) {
      pushReview(`legacy-note:${mapping.packageId}`, {
        level: 'warning',
        code: 'legacy-note',
        message: `旧包缺基线：片段（${mapping.time}）的编码备忘在两边不同，默认保留本地，请复核。`,
        detail: `本地：${localSegment.note || '（空）'}\n离线包：${pkgSegment.note || '（空）'}`,
        segment: { time: mapping.time, speaker: mapping.speaker, text: mapping.text }
      });
      return;
    }
    if (baseNote !== pkgSegment.note && baseNote !== localSegment.note) {
      conflicts.push({
        id: `note:${mapping.packageId}`,
        field: { type: 'segmentNote' },
        segment: {
          packageId: mapping.packageId!, localId: mapping.localId,
          transcriptSourceKey: mapping.transcriptSourceKey, time: mapping.time, speaker: mapping.speaker, text: mapping.text
        },
        baseValue: [baseNote],
        localValue: [localSegment.note],
        packageValue: [pkgSegment.note],
        resolution: 'pending'
      });
      counts.notes.conflicts += 1;
    } else if (baseNote !== pkgSegment.note) {
      counts.notes.updated += 1;
    }
  });

  // 同库重复指纹
  const dupCount = countDuplicateFingerprints(local);
  if (dupCount > 0) {
    migration.push({ code: 'duplicate-fingerprint', level: 'info', message: `本地库有 ${dupCount} 个原文指纹对应多个片段（重复转写行），对齐时按顺序逐个占用。` });
  }

  return {
    preparedAt: new Date().toISOString(),
    coder: pkg.coder,
    coderName: pkg.coderName,
    packageExportedAt: pkg.exportedAt,
    hasBase: Boolean(pkg.base),
    migration,
    transcriptMappings,
    segmentMappings,
    themeMappings,
    conflicts,
    reviews,
    counts
  };
}

function countDuplicateFingerprints(state: CodingState): number {
  const counts = new Map<string, number>();
  state.segments.forEach((segment) => counts.set(segment.fingerprint!, (counts.get(segment.fingerprint!) ?? 0) + 1));
  return [...counts.values()].filter((count) => count > 1).length;
}

function ensureReady(raw: CodingState): CodingState {
  const state = clone(raw);
  ensureAlignmentFields(state.transcripts, state.segments);
  return state;
}

export function setConflictResolution(plan: MergePlan, conflictId: string, resolution: Exclude<ResolutionChoice, 'pending'>): void {
  const conflict = plan.conflicts.find((item) => item.id === conflictId);
  if (conflict) conflict.resolution = resolution;
}

export function acknowledgeReview(plan: MergePlan, reviewId: string, acknowledged: boolean): void {
  const review = plan.reviews.find((item) => item.id === reviewId);
  if (review) review.acknowledged = acknowledged;
}

/**
 * 依据已裁决计划产出合并后状态。存在 pending 冲突 / 未对齐片段时抛错，保证“停下等裁决”。
 */
export function applyMerge(localRaw: CodingState, pkg: CodingPackage, plan: MergePlan): CodingState {
  const pending = plan.conflicts.find((conflict) => conflict.resolution === 'pending');
  if (pending) throw new Error('存在未裁决的冲突，不能提交合并。');
  if (plan.segmentMappings.some((mapping) => mapping.kind === 'unmatched')) throw new Error('存在未对齐的片段，不能提交合并。');
  if (plan.reviews.some((review) => review.level === 'blocking' && !review.acknowledged)) throw new Error('存在未确认的阻塞复核项。');

  const local = ensureReady(localRaw);
  const remote = ensureReady(pkg.state);
  const localPaths = themePathMap(local.themes);
  const pkgPaths = themePathMap(remote.themes);

  // 1. 新访谈
  const transcriptIdMap = new Map<string, string>();
  const newTranscriptIds = new Set<string>();
  plan.transcriptMappings.forEach((mapping) => {
    if (mapping.localId) {
      transcriptIdMap.set(mapping.packageId, mapping.localId);
    } else {
      const id = local.transcripts.some((item) => item.id === mapping.packageId) ? newId('tr') : mapping.packageId;
      const source = remote.transcripts.find((item) => item.id === mapping.packageId)!;
      local.transcripts.push({ ...source, id, sourceKey: mapping.sourceKey });
      transcriptIdMap.set(mapping.packageId, id);
      newTranscriptIds.add(mapping.packageId);
    }
  });

  // 2. 按路径深度补齐缺失主题
  const themeIdMap = new Map<string, string>();
  plan.themeMappings.forEach((mapping) => { if (mapping.localId) themeIdMap.set(mapping.packageId!, mapping.localId); });
  [...plan.themeMappings]
    .filter((mapping) => !mapping.localId)
    .sort((a, b) => a.path.split(PATH_SEP).length - b.path.split(PATH_SEP).length)
    .forEach((mapping) => {
      const source = remote.themes.find((theme) => theme.id === mapping.packageId)!;
      const parentPath = mapping.path.split(PATH_SEP).slice(0, -1).join(PATH_SEP);
      const parentMapping = parentPath ? plan.themeMappings.find((item) => item.path === parentPath) : undefined;
      const parentId = parentMapping ? themeIdMap.get(parentMapping.packageId!) ?? null : null;
      const id = newId('t');
      local.themes.push({ ...source, id, parentId });
      themeIdMap.set(source.id, id);
    });
  const pathToLocalId = new Map<string, string>();
  themePathMap(local.themes).forEach((path, id) => { if (!pathToLocalId.has(path)) pathToLocalId.set(path, id); });

  // 3. 新片段（本地没有对应）
  plan.segmentMappings.forEach((mapping) => {
    if (mapping.localId) return;
    const source = remote.segments.find((segment) => segment.id === mapping.packageId)!;
    const transcriptId = transcriptIdMap.get(source.transcriptId)!;
    const id = local.segments.some((item) => item.id === mapping.packageId) ? newId('s') : mapping.packageId!;
    const brandNewTranscript = newTranscriptIds.has(source.transcriptId);
    const siblings = local.segments.filter((segment) => segment.transcriptId === transcriptId);
    local.segments.push({
      ...source,
      id,
      transcriptId,
      order: brandNewTranscript ? source.order : siblings.reduce((max, segment) => Math.max(max, segment.order), -1) + 1,
      fingerprint: mapping.fingerprint || fingerprintOf(source.text),
      assignments: {
        A: pkg.coder === 'A' ? mapPkgThemeIds(source.assignments.A, themeIdMap) : [],
        B: pkg.coder === 'B' ? mapPkgThemeIds(source.assignments.B, themeIdMap) : []
      }
    });
  });

  const conflictFor = (predicate: (conflict: MergeConflict) => boolean) => plan.conflicts.find(predicate);

  // 4. 判断（仅 pkg.coder 列；另一编码员列保持本地原样，绝不触碰）
  plan.segmentMappings.forEach((mapping) => {
    if (!mapping.localId) return;
    const localSegment = local.segments.find((segment) => segment.id === mapping.localId)!;
    const pkgSegment = remote.segments.find((segment) => segment.id === mapping.packageId)!;
    const localAsPaths = toPaths(localSegment.assignments[pkg.coder], localPaths, 'local');
    const pkgAsPaths = toPaths(pkgSegment.assignments[pkg.coder], pkgPaths, 'pkg');
    const baseAsPaths = pkg.base ? sortedPaths(pkg.base.segmentAssignments[mapping.packageId!]?.[pkg.coder] ?? []) : null;

    let chosen: string[];
    const conflict = conflictFor((candidate) => candidate.field.type === 'assignment'
      && candidate.field.type === 'assignment'
      && (candidate.field as { coder: CoderId }).coder === pkg.coder
      && candidate.segment?.packageId === mapping.packageId);
    if (conflict) {
      chosen = resolveConflictPaths(conflict, localAsPaths, pkgAsPaths);
    } else if (baseAsPaths === null) {
      chosen = unionPaths(localAsPaths, pkgAsPaths);
    } else {
      const pkgChanged = !eqPaths(baseAsPaths, pkgAsPaths);
      const localChanged = !eqPaths(baseAsPaths, localAsPaths);
      chosen = pkgChanged && !localChanged ? pkgAsPaths : localAsPaths;
    }
    localSegment.assignments[pkg.coder] = chosen.map((path) => pathToLocalId.get(path)!).filter(Boolean);
  });

  // 5. 主题字段 + 示例
  plan.themeMappings.forEach((mapping) => {
    if (!mapping.localId) return;
    const localTheme = local.themes.find((theme) => theme.id === mapping.localId)!;
    const pkgTheme = remote.themes.find((theme) => theme.id === mapping.packageId)!;
    const baseTheme = pkg.base?.themes[mapping.packageId!];
    (['definition', 'memo'] as const).forEach((fieldName) => {
      const conflict = conflictFor((candidate) => candidate.field.type === 'themeField' && candidate.field.type === 'themeField'
        && (candidate.field as { field: string }).field === fieldName
        && (candidate.field as { path: string }).path === mapping.path);
      if (conflict) {
        localTheme[fieldName] = resolveConflictScalar(conflict, localTheme[fieldName], pkgTheme[fieldName]);
        return;
      }
      const baseVal = baseTheme?.[fieldName] ?? null;
      if (baseVal !== null && baseVal !== pkgTheme[fieldName] && baseVal === localTheme[fieldName]) {
        localTheme[fieldName] = pkgTheme[fieldName];
      }
    });
    pkgTheme.examples.forEach((example) => { if (!localTheme.examples.includes(example)) localTheme.examples.push(example); });
  });

  // 6. 片段备注
  plan.segmentMappings.forEach((mapping) => {
    if (!mapping.localId) return;
    const localSegment = local.segments.find((segment) => segment.id === mapping.localId)!;
    const pkgSegment = remote.segments.find((segment) => segment.id === mapping.packageId)!;
    const baseNote = pkg.base?.segmentNotes[mapping.packageId!] ?? null;
    const conflict = conflictFor((candidate) => candidate.field.type === 'segmentNote' && candidate.segment?.packageId === mapping.packageId);
    if (conflict) {
      localSegment.note = resolveConflictScalar(conflict, localSegment.note, pkgSegment.note);
    } else if (baseNote !== null && baseNote !== pkgSegment.note && baseNote === localSegment.note) {
      localSegment.note = pkgSegment.note;
    }
  });

  // 7. 署名
  if (pkg.coder === 'A') local.coderA = pkg.coderName || local.coderA;
  else local.coderB = pkg.coderName || local.coderB;

  local.revision += 1;
  local.updatedAt = new Date().toISOString();
  const summary = [
    plan.counts.transcripts.newCount && `新访谈 ${plan.counts.transcripts.newCount}`,
    plan.counts.segments.newCount && `新片段 ${plan.counts.segments.newCount}`,
    plan.counts.themes.created && `按路径新建主题 ${plan.counts.themes.created}`,
    plan.counts.assignments.added && `更新判断 ${plan.counts.assignments.added} 项`,
    plan.conflicts.length && `裁决 ${plan.conflicts.length} 处冲突`
  ].filter(Boolean).join('，');
  local.audit.unshift({
    id: newId('a'),
    at: local.updatedAt,
    action: '合并离线编码包',
    detail: `${plan.coderName}（编码员 ${pkg.coder}）的离线判断已并入${summary ? `：${summary}` : '，无新增条目'}`
  });
  local.audit = local.audit.slice(0, 250);
  return local;
}

const mapPkgThemeIds = (pkgIds: string[], themeIdMap: Map<string, string>): string[] =>
  sortedPaths([...new Set(pkgIds.map((id) => themeIdMap.get(id)).filter(Boolean) as string[])]);

function resolveConflictPaths(conflict: MergeConflict, local: string[], pkg: string[]): string[] {
  switch (conflict.resolution) {
    case 'takePackage': return pkg;
    case 'union': return unionPaths(local, pkg);
    case 'keepLocal':
    case 'skip': return local;
    default: throw new Error('存在未裁决的冲突，不能提交合并。');
  }
}

function resolveConflictScalar(conflict: MergeConflict, local: string, pkg: string): string {
  switch (conflict.resolution) {
    case 'takePackage': return pkg;
    case 'union': return [...new Set([...local.split('\n'), ...pkg.split('\n')])].join('\n');
    case 'keepLocal':
    case 'skip': return local;
    default: throw new Error('存在未裁决的冲突，不能提交合并。');
  }
}

/** 回滚到检查点记录的合并前状态（整包撤回） */
export function rollbackState(beforeState: CodingState): CodingState {
  const next = clone(beforeState);
  next.updatedAt = new Date().toISOString();
  next.audit.unshift({
    id: newId('a'),
    at: next.updatedAt,
    action: '撤回离线编码包',
    detail: '依据合并检查点恢复到合并前状态，整包判断已撤回。'
  });
  next.audit = next.audit.slice(0, 250);
  return next;
}
