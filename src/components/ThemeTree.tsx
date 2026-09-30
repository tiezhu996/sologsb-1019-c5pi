import { For, Show, createMemo, createSignal } from 'solid-js';
import { Button, Chip, Paper, Typography } from '@suid/material';
import type { useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

export default function ThemeTree(props: { store: Store; onCreate: (parentId?: string) => void; onMerge: () => void; onSplit: () => void }) {
  const [query, setQuery] = createSignal('');
  const themes = createMemo(() => props.store.orderedThemes().filter((theme) => theme.name.toLowerCase().includes(query().toLowerCase())));
  const activeSegment = () => props.store.state.segments.find((segment) => segment.id === props.store.state.activeSegmentId);

  const countFor = (themeId: string) => props.store.state.segments.reduce((count, segment) => (
    count + (segment.assignments.A.includes(themeId) || segment.assignments.B.includes(themeId) ? 1 : 0)
  ), 0);

  return (
    <Paper class="panel tree-panel" elevation={0}>
      <div class="panel-heading">
        <div>
          <Typography variant="overline">02 / 主题体系</Typography>
          <Typography variant="h6">层级编码</Typography>
        </div>
        <Button size="small" variant="contained" onClick={() => props.onCreate()}>＋ 一级主题</Button>
      </div>
      <input class="native-input full" placeholder="筛选主题" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
      <div class="theme-help">勾选 A / B 可将当前片段分配给该主题；不同判断会以“分歧”提示。</div>
      <div class="theme-tree">
        <For each={themes()}>{(theme) => {
          const depth = () => {
            let current = theme;
            let level = 0;
            while (current.parentId) {
              level += 1;
              const parent = props.store.state.themes.find((item) => item.id === current.parentId);
              if (!parent) break;
              current = parent;
            }
            return level;
          };
          const assignmentA = () => activeSegment()?.assignments.A.includes(theme.id) ?? false;
          const assignmentB = () => activeSegment()?.assignments.B.includes(theme.id) ?? false;
          return (
            <div class="theme-row" classList={{ active: props.store.state.activeThemeId === theme.id, disagree: assignmentA() !== assignmentB() }}>
              <button class="theme-main" style={{ '--depth': depth(), '--theme-color': theme.color }} onClick={() => props.store.selectTheme(theme.id)}>
                <span class="theme-color" />
                <span class="theme-name">{theme.name}</span>
                <span class="theme-count">{countFor(theme.id)}</span>
              </button>
              <div class="theme-actions">
                <label title={`${props.store.state.coderA} 编码`}><input type="checkbox" checked={assignmentA()} disabled={!activeSegment()} onChange={(event) => activeSegment() && props.store.toggleAssignment(activeSegment()!.id, 'A', theme.id, event.currentTarget.checked)} /> A</label>
                <label title={`${props.store.state.coderB} 编码`}><input type="checkbox" checked={assignmentB()} disabled={!activeSegment()} onChange={(event) => activeSegment() && props.store.toggleAssignment(activeSegment()!.id, 'B', theme.id, event.currentTarget.checked)} /> B</label>
                <button class="icon-text" title="添加子主题" onClick={() => props.onCreate(theme.id)}>＋</button>
              </div>
            </div>
          );
        }}</For>
      </div>
      <Show when={props.store.state.activeThemeId}>
        <div class="tree-footer">
          <Chip size="small" label={`当前：${props.store.state.themes.find((theme) => theme.id === props.store.state.activeThemeId)?.name ?? '未选择'}`} />
          <div class="button-row">
            <Button size="small" onClick={props.onMerge}>合并主题</Button>
            <Button size="small" onClick={props.onSplit}>拆分主题</Button>
          </div>
        </div>
      </Show>
    </Paper>
  );
}
