export type CoderId = 'A' | 'B';

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  /** 原文指纹：跨机器对齐同一片段的依据，旧数据可能缺失，需走迁移清单补算 */
  fingerprint?: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
  /** 访谈来源指纹：不同机器上的同一份访谈据此对齐，旧数据可能缺失 */
  sourceKey?: string;
}

export interface CodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
  /** 本机处于离线编码模式时，携带发出工作包时主库的完整快照 */
  offlineBase?: OfflineBase | null;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

/* ---------- 离线编码包 ---------- */

export interface PackagePayload {
  revision: number;
  updatedAt: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
}

export interface OfflineBase {
  revision: number;
  issuedAt: string;
  base: PackagePayload;
}

/** 发出工作包 / 带回编码包使用同一结构；带回时携带 work（编码后） */
export interface CodingPackage {
  kind: 'coding-package';
  packageVersion: 1;
  issuedAt: string;
  returnedAt?: string;
  coderName?: string;
  /** 发出时主库快照：三方合并的共同祖先；旧数据包可能缺失 */
  base?: PackagePayload;
  work: PackagePayload;
}

/* ---------- 合并计划 ---------- */

export interface MigrationItem {
  kind: 'transcript' | 'segment';
  ref: string;
  detail: string;
  backfilled: boolean;
}

export interface ThemeMapping {
  /** 包里主题 id → 合并后本地主题 id */
  byPackageId: Record<string, string>;
  /** 主题路径 → 本地主题 id（仅含已存在或本次将新建的） */
  byPath: Record<string, string>;
  /** 本次将新建的主题路径，自顶向下 */
  createdPaths: string[];
  /** 同一路径两边元数据不同（不阻断，按本地优先 + 示例并集处理） */
  metadataDiverged: string[];
}

export interface SegmentMapping {
  /** 包内片段 id → 本地片段 id */
  byPackageId: Record<string, string>;
  /** 找不到访谈来源的包内片段 id */
  unknownSource: string[];
  /** 找到来源但指纹匹配不上的包内片段 id */
  unmatched: string[];
}

export interface MergeConflict {
  kind: 'assignment';
  coder: CoderId;
  packageSegmentId: string;
  localSegmentId: string;
  sourceLabel: string;
  time: string;
  speaker: string;
  text: string;
  basePaths: string[];
  localPaths: string[];
  incomingPaths: string[];
  resolution?: 'local' | 'incoming';
}

export interface SegmentMerge {
  packageSegmentId: string;
  localSegmentId: string | null;
  sourceKey: string;
  sourceLabel: string;
  order: number;
  time: string;
  speaker: string;
  text: string;
  fingerprint: string;
  noteIncoming?: string;
  isNewTranscript: boolean;
  /** 每位编码者最终应落库的主题路径；null 表示该位无变化 */
  result: Record<CoderId, string[] | null>;
  changed: CoderId[];
}

export interface MergePlan {
  pkg: CodingPackage;
  themeMapping: ThemeMapping;
  segmentMapping: SegmentMapping;
  conflicts: MergeConflict[];
  segmentMerges: SegmentMerge[];
  newTranscripts: Transcript[];
  /** 主库完全没有的主题路径，将在应用时新建 */
  createdThemes: Array<{ id: string; path: string; name: string; parentPath: string | null; theme: Theme }>;
  warnings: string[];
  /** 旧数据包缺指纹等字段时，需要研究者先确认的迁移清单 */
  migration: MigrationItem[];
  hasBase: boolean;
  coderNames: Partial<Record<CoderId, string>>;
}

/* ---------- 检查点 ---------- */

export interface MergeCheckpoint {
  id: string;
  kind: 'merge';
  packageFileName: string;
  packageSummary: string;
  createdAt: string;
  /** 应用前完整状态（撤回整包用） */
  before: CodingState;
  /** 合并计划（含待裁决冲突解决结果） */
  plan: MergePlan;
}

/** 历史记录只留摘要，避免 localStorage 被完整快照占满 */
export interface CheckpointHistoryEntry {
  id: string;
  packageFileName: string;
  packageSummary: string;
  createdAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
  appliedCounts: { themes: number; transcripts: number; segments: number; judgments: number };
}
