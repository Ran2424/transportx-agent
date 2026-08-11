import xIconUrl from '../assets/x-icon.svg';

export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`transportx-mark${className ? ` ${className}` : ''}`}
      src={xIconUrl}
      alt=""
      aria-hidden="true"
    />
  );
}
