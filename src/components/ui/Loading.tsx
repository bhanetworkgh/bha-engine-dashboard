export function Loading() {
  return (
    <div className="flex items-center gap-2 px-6 py-10 text-faint">
      <span className="pulse-dot h-[7px] w-[7px] rounded-full bg-faint" />
      <span className="text-[13px]">Loading</span>
    </div>
  );
}
