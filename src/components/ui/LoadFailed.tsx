export function LoadFailed({ error }: { error: string }) {
  return <div className="px-5 py-8 text-failing">Could not load this section. {error}</div>;
}
