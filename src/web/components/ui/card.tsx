import type { HTMLAttributes } from 'react';

type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className = '', ...props }: CardProps) {
  return <div className={`ui-card${className ? ` ${className}` : ''}`} {...props} />;
}

export function CardHeader({ className = '', ...props }: CardProps) {
  return <div className={`ui-card-header${className ? ` ${className}` : ''}`} {...props} />;
}

export function CardTitle({ className = '', ...props }: CardProps) {
  return <h2 className={`ui-card-title${className ? ` ${className}` : ''}`} {...props} />;
}

export function CardDescription({ className = '', ...props }: CardProps) {
  return <p className={`ui-card-description${className ? ` ${className}` : ''}`} {...props} />;
}
