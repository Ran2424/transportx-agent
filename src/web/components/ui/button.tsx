import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'quiet' | 'outline';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button-${variant}${className ? ` ${className}` : ''}`}
      {...props}
    />
  );
}
