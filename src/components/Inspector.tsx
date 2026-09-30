import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Button, Chip, Divider, Paper, Typography } from '@suid/material';
import type { Theme } from '../types';
import type { useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

export default function Inspector(props: { store: Store }) {
  const [definition, setDefinition] = createSignal('');
  const [memo, setMemo] = createSignal('');
  const [example, setExample] = createSignal('');
  const [segmentNote, setSegmentNote] = createSignal('');
  const [section, setSection] = createSignal<'theme' | 'compare' | 'audit'>('theme');

  const theme = createMemo(() => props.store.state.themes.find((item) => item.id === props.store.state.activeThemeId));
  const segment = createMemo(() => props.store.state.segments.find((item) => item.id === props.store.state.activeSegmentId));
  const citations = createMemo(() => {
    const current = theme();
    if (!current) return [];
    return props.store.state.segments.filter((item) => item.assignments.A.includes(current.id) || item.assignments.B.includes(current.id));
  });

  createEffect(() => {
    const current = theme();
    setDefinition(current?.definition ?? '');
    setMemo(current?.memo ?? '');
    setExample('');
  });

  createEffect(() => setSegmentNote(segment()?.note ?? ''));

  const saveThemeField = (field: 'definition' | 'memo', value: string) => {
    const current = theme();
    if (!current || current[field] === value) return;
    props.store.updateTheme(current.id, { [field]: value } as Partial<Theme>, field === 'definition' ? '主题定义' : '研究备忘录');
  };

  const saveNote = () => {
    const current = segment();
    if (!current || current.note === segmentNote()) return;
    props.store.updateSegment(current.id, { speaker: current.speaker, time: current.time, text: current.text, note: segmentNote() });
  };

  return (
    <Paper class="panel inspector-panel" elevation={0}>
      <div class="panel-heading">
        <div>
          <Typography variant="overline">03 / 研究记录</Typography>
          <Typography variant="h6">主题与判断</Typography>
        </div>
      </div>
      <div class="inspector-tabs">
        <button classList={{ active: section() === 'theme' }} onClick={() => setSection('theme')}>主题记事</button>
        <button classList={{ active: section() === 'compare' }} onClick={() => setSection('compare')}>双人比较</button>
        <button classList={{ active: section() === 'audit' }} onClick={() => setSection('audit')}>操作记录</button>
      </div>
      <Divider />

      <Show when={section() === 'theme'}>
        <Show when={theme()} fallback={<div class="empty-state">从中间主题树选择一个主题，添加定义、备忘录和示例。</div>}>
          {(current) => <>
            <div class="selected-theme-title"><span style={{ background: current().color }} /> <strong>{current().name}</strong></div>
            <Show when={segment()}>
              {(activeSegment) => <div class="quote-card">
                <div class="quote-meta">{activeSegment().time} · {activeSegment().speaker}</div>
                <blockquote>“{activeSegment().text}”</blockquote>
                <button class="link-button" onClick={() => document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>↗ 回到原文位置</button>
              </div>}
            </Show>
            <label class="field-label">操作定义
              <textarea class="native-textarea" value={definition()} onInput={(event) => setDefinition(event.currentTarget.value)} onBlur={() => saveThemeField('definition', definition())} placeholder="说明什么内容应/不应归入该主题" />
            </label>
            <label class="field-label">研究备忘录
              <textarea class="native-textarea" value={memo()} onInput={(event) => setMemo(event.currentTarget.value)} onBlur={() => saveThemeField('memo', memo())} placeholder="记录判断边界、疑问或编码规则" />
            </label>
            <label class="field-label">添加典型示例
              <div class="inline-input">
                <input class="native-input" value={example()} onInput={(event) => setExample(event.currentTarget.value)} placeholder="输入示例文本" />
                <Button size="small" variant="contained" disabled={!example().trim()} onClick={() => { props.store.addExample(current().id, example()); setExample(''); }}>添加</Button>
              </div>
            </label>
            <Show when={current().examples.length} fallback={<div class="muted">暂无示例</div>}>
              <ul class="example-list"><For each={current().examples}>{(item) => <li>{item}</li>}</For></ul>
            </Show>
            <Show when={citations().length}>
              <div class="citation-heading">回原文引用 <span>{citations().length} 条</span></div>
              <div class="citation-list">
                <For each={citations()}>{(item) => (
                  <button class="citation-link" onClick={() => { props.store.selectSegment(item.id); window.setTimeout(() => document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0); }}>
                    <span>{item.time} · {item.speaker}</span>
                    <p>{item.text}</p>
                  </button>
                )}</For>
              </div>
            </Show>
          </>}
        </Show>
      </Show>

      <Show when={section() === 'compare'}>
        <Show when={segment()} fallback={<div class="empty-state">请先从左侧正文选择片段。</div>}>
          {(activeSegment) => <>
            <div class="compare-intro">比较同一位受访者在同一片段上的主题判断。任何不一致都会保留，直到研究者明确调整。</div>
            <div class="compare-grid">
              <div class="coder-column">
                <div class="coder-header"><span class="avatar">A</span><strong>{props.store.state.coderA}</strong></div>
                <For each={activeSegment().assignments.A} fallback={<div class="muted">未编码</div>}>{(id) => <div class="compare-chip"><Chip size="small" label={props.store.state.themes.find((item) => item.id === id)?.name ?? '未知主题'} /><button class="icon-text" onClick={() => props.store.toggleAssignment(activeSegment().id, 'A', id, false)}>×</button></div>}</For>
                <select class="native-select full" value="" onChange={(event) => event.currentTarget.value && props.store.toggleAssignment(activeSegment().id, 'A', event.currentTarget.value, true)}>
                  <option value="">＋ 给编码者 A 添加主题</option>
                  <For each={props.store.orderedThemes()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                </select>
              </div>
              <div class="coder-column">
                <div class="coder-header"><span class="avatar b">B</span><strong>{props.store.state.coderB}</strong></div>
                <For each={activeSegment().assignments.B} fallback={<div class="muted">未编码</div>}>{(id) => <div class="compare-chip"><Chip size="small" label={props.store.state.themes.find((item) => item.id === id)?.name ?? '未知主题'} /><button class="icon-text" onClick={() => props.store.toggleAssignment(activeSegment().id, 'B', id, false)}>×</button></div>}</For>
                <select class="native-select full" value="" onChange={(event) => event.currentTarget.value && props.store.toggleAssignment(activeSegment().id, 'B', event.currentTarget.value, true)}>
                  <option value="">＋ 给编码者 B 添加主题</option>
                  <For each={props.store.orderedThemes()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                </select>
              </div>
            </div>
            <Show when={activeSegment().assignments.A.join('|') !== activeSegment().assignments.B.join('|')} fallback={<div class="agreement">✓ 当前判断完全一致</div>}>
              <div class="disagreement">⚠ 当前判断存在分歧，导出结果仍会同时保留两位编码者记录。</div>
            </Show>
            <label class="field-label">片段编码备忘
              <textarea class="native-textarea" value={segmentNote()} onInput={(event) => setSegmentNote(event.currentTarget.value)} onBlur={saveNote} placeholder="记录此片段的分歧处理或引文提示" />
            </label>
          </>}
        </Show>
      </Show>

      <Show when={section() === 'audit'}>
        <div class="audit-summary">
          <div><strong>{props.store.state.audit.length}</strong><span>次最近操作</span></div>
          <div><strong>{citations().length}</strong><span>条当前主题引用</span></div>
        </div>
        <div class="audit-list">
          <For each={props.store.state.themes.filter((item) => item.definition || item.memo)}>{(item) => (
            <div class="citation" onClick={() => props.store.selectTheme(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.definition ? '含操作定义' : ''}{item.definition && item.memo ? ' · ' : ''}{item.memo ? '含备忘录' : ''}</span>
            </div>
          )}</For>
        </div>
        <Divider />
        <div class="audit-list">
          <For each={props.store.state.audit.slice(0, 14)}>{(entry) => (
            <div class="audit-item"><span>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span><div><strong>{entry.action}</strong><p>{entry.detail}</p></div></div>
          )}</For>
        </div>
      </Show>
    </Paper>
  );
}
