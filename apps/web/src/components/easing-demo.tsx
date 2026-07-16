export default function EasingDemo({
  path,
  color,
  label,
}: {
  path: string;
  color: string;
  label: string;
}) {
  return (
    <div className="rounded-[10px] border border-lp-border bg-white/[0.02] p-3">
      <svg
        viewBox="0 -22 125 134"
        className="block h-auto w-full max-w-full"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[10.5px] font-bold tracking-[0.04em] text-lp-faint">
        {label}
      </span>
    </div>
  );
}
