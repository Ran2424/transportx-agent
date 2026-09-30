export function FeatureEmpty({ mark, title, description }: { mark: string; title: string; description: string }) {
  return <section className="feature-empty"><span>{mark}</span><strong>{title}</strong><p>{description}</p></section>;
}
