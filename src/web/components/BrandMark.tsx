import xRibbonUrl from '../assets/x-ribbon-icon.svg';

export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`transportx-mark${className ? ` ${className}` : ''}`}
      style={{ WebkitMaskImage: `url("${xRibbonUrl}")`, maskImage: `url("${xRibbonUrl}")` }}
      aria-hidden="true"
    />
  );
}
