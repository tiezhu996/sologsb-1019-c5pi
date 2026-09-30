import { createSignal, Show } from 'solid-js';
import type { useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

const readFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(file);
});

type Notice = { kind: 'ok' | 'err'; text: string } | null;

export default function OfflinePackageDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const offline = () => props.store.offlineSession();
  const [mode, setMode] = createSignal<'send' | 'open'>('send');
  const [coderName, setCoderName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<Notice>(null);

  const handleSend = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await props.store.sendOfflinePackage(coderName().trim());
      setNotice({ kind: 'ok', text: '工作包已生成并下载。把该 JSON 交给编码员，离线期间其机器上的编号互不影响。' });
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const raw = await readFile(file);
      const summary = await props.store.openOfflinePackage(raw);
      setNotice({ kind: 'ok', text: `已进入离线编码模式：${summary}` });
      props.onClose();
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleReturn = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await props.store.returnOfflinePackage();
      setNotice({ kind: 'ok', text: '完成包已导出。把它交回主库机器，在“合并编码包”中导入即可。' });
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleExit = async () => {
    setBusy(true);
    await props.store.exitOfflineSession();
    setBusy(false);
    props.onClose();
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <div><span class="eyebrow">OFFLINE PACKAGE</span><h2>离线编码包</h2></div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </header>

        <Show when={offline()}>
          <div class="warning-box merge-note">
            当前处于<strong>离线编码模式</strong>。工作包发出于 {offline()?.issuedAt.slice(0, 10)}，所有改动都只写入工作包，不会影响主库。
          </div>
          <p class="modal-intro">编码完成后导出完成包并交回主库机器；也可以退出离线模式，恢复本机原有的库。</p>
          <div class="button-row package-actions">
            <button class="button primary" disabled={busy()} onClick={handleReturn}>导出完成包</button>
            <button class="button secondary" disabled={busy()} onClick={handleExit}>退出离线模式（恢复本机库）</button>
          </div>
        </Show>

        <Show when={!offline()}>
          <div class="package-tabs">
            <button classList={{ active: mode() === 'send' }} onClick={() => { setMode('send'); setNotice(null); }}>① 主库发出工作包</button>
            <button classList={{ active: mode() === 'open' }} onClick={() => { setMode('open'); setNotice(null); }}>② 编码机打开工作包</button>
          </div>

          <Show when={mode() === 'send'}>
            <p class="modal-intro">工作包内含发出瞬间的完整快照作为共同基线。编码员离线改动后，主库据此做三方合并：同一片段不会被当成两处新修改，只有同一位编码员两边都改了同一项且结果不同才需要裁决。</p>
            <label class="field-label">编码员姓名（用于审计与文件名）
              <input class="native-input full" value={coderName()} onInput={(event) => setCoderName(event.currentTarget.value)} placeholder="例如：赵研究员" />
            </label>
            <div class="button-row package-actions">
              <button class="button primary" disabled={busy()} onClick={handleSend}>生成并下载工作包</button>
            </div>
          </Show>

          <Show when={mode() === 'open'}>
            <p class="modal-intro">在编码员自己的电脑上选择收到的工作包。系统会先把本机当前的库存好，载入工作包后即可离线编码；完成后用同一入口导出完成包。</p>
            <label class="package-file">
              <input type="file" accept="application/json,.json" disabled={busy()} onChange={(event) => void handleOpen(event.currentTarget.files?.[0])} />
            </label>
          </Show>
        </Show>

        <Show when={notice()}>
          <div class={notice()!.kind === 'ok' ? 'agreement' : 'disagreement'}>{notice()!.text}</div>
        </Show>
      </section>
    </div>
  );
}
