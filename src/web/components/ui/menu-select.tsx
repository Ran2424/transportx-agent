import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon } from '../icons';

export type MenuSelectOption = {
  value: string;
  label: string;
  metadata?: string;
};

export function MenuSelect({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  autoFocus = false,
  compact = false,
  onChange,
}: {
  label: string;
  value: string;
  options: MenuSelectOption[];
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selectedOption = optionRefs.current[selectedIndex];
      selectedOption?.focus({ preventScroll: true });
      const firstVisibleOption = optionRefs.current[Math.max(0, selectedIndex - 2)];
      if (popoverRef.current && firstVisibleOption) popoverRef.current.scrollTop = Math.max(0, firstVisibleOption.offsetTop - 5);
    });
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnResize = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeOnResize);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [open, selectedIndex]);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const opensAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(272, Math.max(160, opensAbove ? spaceAbove : spaceBelow));
    setPopoverStyle(opensAbove
      ? { left: 0, bottom: rect.height + 6, width: '100%', maxHeight }
      : { left: 0, top: rect.height + 6, width: '100%', maxHeight });
    setOpen(true);
  }

  function focusOption(index: number) {
    if (!options.length) return;
    optionRefs.current[(index + options.length) % options.length]?.focus();
  }

  function handleOptionKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="field-label">
      <span>{label}</span>
      <div
        className={`menu-select${compact ? ' is-compact' : ''}`}
        ref={rootRef}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!event.currentTarget.contains(next) && !popoverRef.current?.contains(next)) setOpen(false);
        }}
      >
        <button
          className="menu-select-trigger"
          type="button"
          ref={triggerRef}
          autoFocus={autoFocus}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={toggleMenu}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!open) toggleMenu();
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        >
          <span className="menu-select-value">
            <strong>{selected?.label || placeholder}</strong>
            {selected?.metadata ? <small>{selected.metadata}</small> : null}
          </span>
          <Icon name="chevron" />
        </button>
        {open ? (
          <div
            className={`menu-select-popover${compact ? ' is-compact' : ''}`}
            role="listbox"
            aria-label={label}
            ref={popoverRef}
            style={popoverStyle}
          >
            {options.map((option, index) => (
              <button
                className={`menu-select-option${option.value === value ? ' is-selected' : ''}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                key={option.value}
                ref={(node) => { optionRefs.current[index] = node; }}
                onKeyDown={(event) => handleOptionKey(event, index)}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.metadata ? <small>{option.metadata}</small> : null}
                </span>
                {option.value === value ? <i aria-hidden="true">✓</i> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
