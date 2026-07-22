const boundaries = [
  ['01', 'Pi JSONL', '长期事实与可恢复的会话分支'],
  ['02', 'Browser Kernel', '事件归一化、命令端口与浏览器投影'],
  ['03', 'React Adapter', '只负责交互、布局和可替换的展示层'],
] as const;

export default function AdapterNote() {
  return (
    <div className="adapter-note" data-testid="lazy-note">
      <div className="adapter-note-heading">
        <span className="eyebrow">LAZY MODULE / READY</span>
        <span className="adapter-note-line" aria-hidden="true" />
      </div>
      <div className="adapter-boundaries">
        {boundaries.map(([index, title, description]) => (
          <div className="adapter-boundary" key={index}>
            <span className="adapter-boundary-index">{index}</span>
            <div>
              <strong>{title}</strong>
              <p>{description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
