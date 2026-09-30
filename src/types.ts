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
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
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
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}
