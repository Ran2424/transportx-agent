import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { Dialog, DialogClose } from './dialog';

type ConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
};

export function ConfirmationDialog({ open, title, description, confirmLabel, onOpenChange, onConfirm }: ConfirmationDialogProps) {
  const { t } = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange} title={title} className="confirmation-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose><Button type="button" variant="danger" onClick={onConfirm}>{confirmLabel}</Button></>}>
    <p className="confirmation-dialog-copy">{description}</p>
  </Dialog>;
}
