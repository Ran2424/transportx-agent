import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../components/ui/dialog';
import { Icon } from '../../components/icons';

export type CommandItem = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  disabled?: boolean;
  action(): void | Promise<void>;
};

export function CommandPalette({ open, onOpenChange, commands }: { open: boolean; onOpenChange(open: boolean): void; commands: CommandItem[] }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return commands.filter((command) => !normalized || `${command.label} ${command.description}`.toLocaleLowerCase().includes(normalized));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [activeIndex, filtered.length]);

  async function run(command: CommandItem) {
    if (command.disabled) return;
    onOpenChange(false);
    await command.action();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="命令" eyebrow="QUICK CONTROL" description="输入关键词筛选，使用 ↑ ↓ 导航、Enter 执行。" className="command-dialog">
      <label className="command-search">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          placeholder="搜索工作台命令…"
          aria-label="搜索命令"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              const next = Math.min(activeIndex + 1, filtered.length - 1);
              setActiveIndex(next);
              itemRefs.current[next]?.focus();
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.max(activeIndex - 1, 0);
              setActiveIndex(next);
              itemRefs.current[next]?.focus();
            } else if (event.key === 'Enter' && filtered[activeIndex]) {
              event.preventDefault();
              void run(filtered[activeIndex]);
            }
          }}
        />
      </label>
      <div className="command-list" role="listbox" aria-label="工作台命令">
        {filtered.map((command, index) => (
          <button
            className={`command-row${index === activeIndex ? ' is-active' : ''}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            disabled={command.disabled}
            key={command.id}
            ref={(node) => { itemRefs.current[index] = node; }}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => void run(command)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = event.key === 'ArrowDown' ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0);
                setActiveIndex(next);
                itemRefs.current[next]?.focus();
              }
            }}
          >
            <span><strong>{command.label}</strong><small>{command.description}</small></span>
            {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span className="command-arrow">↗</span>}
          </button>
        ))}
        {filtered.length === 0 ? <div className="command-empty">没有匹配的命令</div> : null}
      </div>
    </Dialog>
  );
}
