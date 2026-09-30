import type { Segment, Transcript } from '../types';

/**
 * 归一化原文：统一空白与全角标点、去除首尾空白、折叠连续空格。
 * 同一段访谈在两台机器上即使编号不同，只要文本一致，归一化结果就一致。
 */
export const normalizeText = (text: string): string =>
  text
    .replace(/[　\s]+/g, ' ')
    .replace(/[，､]/g, ',')
    .replace(/[。．]/g, '.')
    .replace(/[：﹕]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim();

/** cyrb53：纯同步、确定性 53 位哈希，输出 16 位十六进制，作为原文指纹 */
export const cyrb53 = (input: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(14, '0');
};

export const fingerprintOf = (text: string): string => `fp-${cyrb53(normalizeText(text))}`;

/** 访谈来源稳定键：优先来源文件名，缺失时退化为标题 */
export const transcriptSourceKey = (transcript: Pick<Transcript, 'sourceName' | 'title'>): string => {
  const source = normalizeText(transcript.sourceName || '').toLowerCase();
  const title = normalizeText(transcript.title || '').toLowerCase();
  return `src:${source || '∅'}|t:${title || '∅'}`;
};

/** 回填旧数据缺失的 sourceKey / fingerprint（就地），返回是否发生改动 */
export const ensureAlignmentFields = (
  transcripts: Transcript[],
  segments: Segment[]
): { changed: boolean; duplicateFingerprints: string[] } => {
  let changed = false;
  transcripts.forEach((transcript) => {
    if (!transcript.sourceKey) {
      transcript.sourceKey = transcriptSourceKey(transcript);
      changed = true;
    }
  });
  const seen = new Map<string, number>();
  segments.forEach((segment) => {
    if (!segment.fingerprint) {
      segment.fingerprint = fingerprintOf(segment.text);
      changed = true;
    }
    seen.set(segment.fingerprint, (seen.get(segment.fingerprint) ?? 0) + 1);
  });
  const duplicateFingerprints = [...seen.entries()].filter(([, count]) => count > 1).map(([fp]) => fp);
  return { changed, duplicateFingerprints };
};

/** 基于二元集合 Dice 系数的相似度（对中文按字符 bigram，足够稳健地识别“只差标点/口误修正”的同一段） */
export const textSimilarity = (a: string, b: string): number => {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left === right) return 1;
  if (!left || !right) return 0;
  const bigrams = (value: string) => {
    const grams = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };
  const ga = bigrams(left);
  const gb = bigrams(right);
  let overlap = 0;
  ga.forEach((count, gram) => { overlap += Math.min(count, gb.get(gram) ?? 0); });
  const total = [...ga.values()].reduce((sum, count) => sum + count, 0)
    + [...gb.values()].reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
};

/** 模糊匹配阈值：高于此值可作为建议候选，最终仍需研究者确认 */
export const FUZZY_SUGGEST = 0.72;
