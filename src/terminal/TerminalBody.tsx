/**
 * 终端窗口内容组件（WF-11）：单设备上下文、命令历史（↑/↓）、实时流式输出。
 * 由 Shell 以悬浮 Card 承载（位置/拖拽在 Shell），本组件只管理终端内状态并驱动
 * 命令注册表与每窗口独立的 SimulationEngine。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { registry, unknownCommand, type TermCtx } from './commands';
import i18n from '@/i18n';

export interface TerminalBodyProps {
  deviceId: string;
  /** 请求关闭本窗口。 */
  onClose(): void;
}

function splitArgv(line: string): string[] {
  // 支持双引号分组（引号内空格不分割）
  const argv: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    argv.push(m[1] ?? m[2] ?? m[3]!);
  }
  return argv;
}

function promptText(label: string, cwd: string[]): string {
  return `root@${label}:${cwd.length ? '/' + cwd.join('/') : '/'}#`;
}

export default function TerminalBody({ deviceId, onClose }: TerminalBodyProps) {
  const device = useStore((s) => s.topology.devices[deviceId]);
  const [lines, setLines] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const cwdRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef(0);
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const genRef = useRef(0);

  const engine = useMemo(
    () =>
      new SimulationEngine({
        getTopology: () => useStore.getState().topology,
        patchDevice: (id, patch) => useStore.getState().updateDevice(id, patch),
      }),
    [],
  );
  // 组件卸载（窗口关闭）清空引擎等待者与计时器
  useEffect(() => () => engine.reset(), [engine]);

  useEffect(() => {
    if (device && lines.length === 0 && !busyRef.current) {
      setLines([i18n.t('term.welcome', { label: device.label })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.id, device?.label]); // 仅打开/改名时初始化欢迎语

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const label = device?.label ?? deviceId;

  const pushLine = (text: string) => {
    setLines((ls) => [...ls, ...text.split('\n')]);
  };

  async function dispatch(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === 'clear') {
      setLines([]);
      return;
    }
    const argv = splitArgv(trimmed);
    const name = argv[0]!;
    const gen = genRef.current;
    const ctx: TermCtx = {
      deviceId,
      print: pushLine,
      engine,
      cwd: () => [...cwdRef.current],
      setCwd: (segs) => {
        cwdRef.current = segs;
      },
      setBusy: (b) => {
        busyRef.current = b;
        setBusy(b);
      },
      close: onClose,
    };
    setLines((ls) => [...ls, `${promptText(label, cwdRef.current)} ${trimmed}`]);
    const handler = registry[name];
    if (handler) {
      await handler(ctx, argv, trimmed);
    } else {
      unknownCommand(ctx, name);
    }
    if (gen !== genRef.current) return; // 窗口已关闭：丢弃后续输出
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = input;
      if (!line.trim()) return;
      histRef.current.push(line);
      histIdxRef.current = histRef.current.length;
      setInput('');
      void dispatch(line);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdxRef.current === 0) return;
      histIdxRef.current -= 1;
      setInput(histRef.current[histIdxRef.current] ?? '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdxRef.current >= histRef.current.length) return;
      histIdxRef.current += 1;
      setInput(histRef.current[histIdxRef.current] ?? '');
    }
  }

  return (
    <div
      style={{
        background: '#141414', color: '#d6deeb', fontFamily: 'Consolas, Menlo, monospace',
        fontSize: 13, height: 320, overflowY: 'auto', padding: 10, borderRadius: 4,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div ref={outRef} style={{ minHeight: 0 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{l}</div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <span style={{ color: '#9ece6a', flexShrink: 0 }}>{promptText(label, cwdRef.current)}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          autoFocus
          spellCheck={false}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: '#d6deeb', fontFamily: 'inherit', fontSize: 13,
          }}
        />
      </div>
    </div>
  );
}
