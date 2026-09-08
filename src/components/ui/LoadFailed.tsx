export function LoadFailed({ error }: { error: string }) {
  return (
    <div className="px-6 py-10">
      <div className="inline-flex max-w-[60ch] items-start gap-3 rounded-[12px] bg-failing-soft px-4 py-3 text-failing">
        <span className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-failing" />
        <span className="text-[13px] leading-relaxed">Could not load this section. {error}</span>
      </div>
    </div>
  );
}
