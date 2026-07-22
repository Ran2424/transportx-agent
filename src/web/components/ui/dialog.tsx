import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ComponentProps, type ReactNode } from 'react';

type DialogProps = ComponentProps<typeof DialogPrimitive.Root> & {
  title: string;
  description?: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function Dialog({
  title,
  description,
  eyebrow,
  children,
  footer,
  className = '',
  ...rootProps
}: DialogProps) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const isOpen = rootProps.open ?? rootProps.defaultOpen ?? false;
  if (isOpen && !wasOpen.current) {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = isOpen;

  return (
    <DialogPrimitive.Root {...rootProps}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className={`dialog-surface ${className}`.trim()}
          onCloseAutoFocus={(event) => {
            if (!previousFocus.current) return;
            event.preventDefault();
            previousFocus.current.focus();
            previousFocus.current = null;
          }}
        >
          <div className="dialog-heading">
            <div>
              {eyebrow ? <div className="dialog-eyebrow"><span />{eyebrow}</div> : null}
              <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className={description ? 'dialog-description' : 'sr-only'}>
                {description || `${title}对话框`}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="icon-button dialog-close" aria-label="关闭">
              <span aria-hidden="true">×</span>
            </DialogPrimitive.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogClose = DialogPrimitive.Close;
