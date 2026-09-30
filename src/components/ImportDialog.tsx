import { createSignal } from 'solid-js';

export default function ImportDialog(props: {
  open: boolean;
  onClose: () => void;
  onImport: (raw: string, title: string, participant: string, sourceName: string) => void;
}) {
  const [title, setTitle] = createSignal('');
  const [participant, setParticipant] = createSignal('');
  const [sourceName, setSourceName] = createSignal('');
  const [raw, setRaw] = createSignal('');

  const submit = () => {
    if (!raw().trim()) return;
    props.onImport(raw(), title().trim() || '未命名访谈', participant().trim() || '受访者', sourceName().trim() || '手工导入');
    setTitle(''); setParticipant(''); setSourceName(''); setRaw('');
    props.onClose();
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header><div><span class="eyebrow">IMPORT</span><h2 id="import-title">导入访谈转写</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
        <p class="modal-intro">支持每行“时间 · 发言人：原文”，也可以直接粘贴普通段落；普通段落会按行自动生成时间码并交替标注访谈者。</p>
        <div class="form-grid">
          <label>访谈标题<input class="native-input" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="例如：王梅访谈：社区记忆" /></label>
          <label>受访者<input class="native-input" value={participant()} onInput={(event) => setParticipant(event.currentTarget.value)} placeholder="受访者姓名或代号" /></label>
          <label>来源文件<input class="native-input" value={sourceName()} onInput={(event) => setSourceName(event.currentTarget.value)} placeholder="录音编号、手稿编号或文件名" /></label>
        </div>
        <label class="field-label">转写正文
          <textarea class="native-textarea import-textarea" value={raw()} onInput={(event) => setRaw(event.currentTarget.value)} placeholder={'00:00:08 访谈者：请讲讲您的求学经历。\n00:00:14 受访者：我是在临河镇长大的……'} />
        </label>
        <footer><button class="button secondary" onClick={props.onClose}>取消</button><button class="button primary" disabled={!raw().trim()} onClick={submit}>导入并开始编码</button></footer>
      </section>
    </div>
  );
}
