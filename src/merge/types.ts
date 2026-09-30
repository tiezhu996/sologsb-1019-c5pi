import type { CoderId, CodingState } from '../types';

/** 离线编码包格式版本 */
export const PACKAGE_KIND = 'interview-coding-offline-pack';

/** 片段在某编码员列上的判断（按路径解析后的主题集合），用排序后的主题路径序列表示 */
export type AssignmentValue = string[];

/** 三方合并所依据的基线快照（离线下发时刻的库），只保留对齐与判断所需字段 */
export interface PackageBaseSnapshot {
  revision: number;
  updatedAt: string;
  coderA: string;
  coderB: string;
  /** base 中每个片段每编码员的判断（以主题路径表示，避免被两端不同的主题编号干扰） */
  segmentAssignments: Record<string, Record<CoderId, string[]>>;
  /** base 中片段备注 */
  segmentNotes: Record<string, string>;
  /** base 中按主题 id 记录的可冲突字段 */
  themes: Record<string, { definition?: string; memo?: string; examples?: string[] }>;
}

/** 编码员带回的离线编码包 */
export interface CodingPackage {
  kind: typeof PACKAGE_KIND;
  packageVersion: 1;
  exportedAt: string;
  /** 实际在离线端编码的编码员；其判断列才会被并入本地库 */
  coder: CoderId;
  coderName: string;
  /** 离线库（编码员带回的整库快照，主题/片段编号可能与本地不同） */
  state: CodingState;
  /** 下发时刻基线。旧数据包可能缺失，此时引擎改为生成迁移/复核清单而非静默覆盖 */
  base?: PackageBaseSnapshot;
  note?: string;
}

export type AlignKind = 'fingerprint' | 'fuzzy' | 'manual' | 'new' | 'unmatched';

export interface TranscriptMapping {
  localId: string | null;
  packageId: string;
  sourceKey: string;
  title: string;
  kind: AlignKind;
}

export interface SegmentMapping {
  localId: string | null;
  packageId: string | null;
  transcriptSourceKey: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  fingerprint: string;
  /** 指纹精确命中为 fingerprint；旧包缺指纹走 fuzzy；研究者手工指定为 manual；本地没有则 new；无法确认 unmatched */
  kind: AlignKind;
  similarity?: number;
}

export interface ThemeMapping {
  /** 路径，根 → 叶，以 ' / ' 连接 */
  path: string;
  localId: string | null;
  packageId: string | null;
  kind: AlignKind;
}

export type ConflictField =
  | { type: 'assignment'; coder: CoderId }
  | { type: 'segmentNote' }
  | { type: 'themeField'; field: 'definition' | 'memo'; path: string };

export interface MergeConflict {
  id: string;
  field: ConflictField;
  /** 受影响片段：assignment / segmentNote 时存在 */
  segment?: { packageId: string; localId: string | null; transcriptSourceKey: string; time: string; speaker: string; text: string };
  /** 三方取值，主题路径或文本 */
  baseValue: string[];
  localValue: string[];
  packageValue: string[];
  resolution: ResolutionChoice;
}

export type ResolutionChoice = 'pending' | 'keepLocal' | 'takePackage' | 'union' | 'skip';

/** 不阻塞合并、但需要研究者知悉/确认的条目（如旧包无基线时无法判定改动归属） */
export interface MergeReview {
  id: string;
  level: 'info' | 'warning' | 'blocking';
  code: string;
  message: string;
  detail?: string;
  segment?: { time: string; speaker: string; text: string };
  acknowledged: boolean;
}

export interface MigrationItem {
  code:
    | 'legacy-no-fingerprint'
    | 'legacy-no-base'
    | 'package-not-a-pack'
    | 'segment-text-drift'
    | 'duplicate-fingerprint'
    | 'unknown-theme-reference';
  level: 'info' | 'warning' | 'blocking';
  message: string;
  detail?: string;
}

export interface MergeCounts {
  transcripts: { matched: number; newCount: number };
  segments: { fingerprint: number; fuzzy: number; manual: number; newCount: number; unmatched: number };
  themes: { matched: number; created: number };
  assignments: { added: number; removed: number; unchanged: number; conflicts: number };
  themeFields: { updated: number; conflicts: number };
  notes: { updated: number; conflicts: number };
}

export interface MergePlan {
  preparedAt: string;
  coder: CoderId;
  coderName: string;
  packageExportedAt: string;
  hasBase: boolean;
  migration: MigrationItem[];
  transcriptMappings: TranscriptMapping[];
  segmentMappings: SegmentMapping[];
  themeMappings: ThemeMapping[];
  conflicts: MergeConflict[];
  reviews: MergeReview[];
  counts: MergeCounts;
}

export function isBlocking(plan: MergePlan): boolean {
  return (
    plan.conflicts.some((item) => item.resolution === 'pending') ||
    plan.reviews.some((item) => item.level === 'blocking' && !item.acknowledged) ||
    plan.segmentMappings.some((item) => item.kind === 'unmatched')
  );
}

export interface MergeCheckpoint {
  id: string;
  createdAt: string;
  package: CodingPackage;
  plan: MergePlan;
  beforeState: CodingState;
  afterState: CodingState | null;
  status: 'prepared' | 'applied-pending-write' | 'committed' | 'rolled-back';
  revisionBefore: number;
  revisionAfter: number | null;
  lastError?: string;
}
