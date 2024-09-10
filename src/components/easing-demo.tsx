import styles from "@/app/styles.module.css"
import { cn } from "@/lib/utils";

export default function EasingDemo({ path, easing, type }: { path: string, easing: string, type: "in" | "out" | "inOut" }) {
  return (
    <div className="relative">
      <svg className="overflow-visible" viewBox="0 0 125 85" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {type === "in" &&
            <linearGradient id="in" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="hsl(var(--foreground))" />
              <stop offset="50%" stop-color="hsl(var(--foreground))" />
              <stop offset="70%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="100%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
            </linearGradient>}
          {type === "out" &&
            <linearGradient id="out" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="30%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="50%" stop-color="hsl(var(--foreground))" />
              <stop offset="100%" stop-color="hsl(var(--foreground))" />
            </linearGradient>}
          {type === "inOut" &&
            <linearGradient id="inOut" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="hsl(var(--foreground))" />
              <stop offset="20%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="80%" stop-color="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="100%" stop-color="hsl(var(--foreground))" />
            </linearGradient>}
        </defs>
        <title>{type}</title>
        <g>
          <path d="M1 0v84h124" strokeLinecap="round" strokeWidth="2" fill="none" stroke="#ffffff">
          </path>
        </g>
        <path className="translate-x-[1px] translate-y-[-1px]"
          strokeLinecap="round" d={path}
          strokeWidth="2" fill="none" stroke={`url(#${type})`} />
      </svg>
      <div
        className={cn(styles.easingDemo,
          "bg-primary w-2 h-2 rounded absolute top-full -right-3 -translate-y-[5.5px] will-change-[top]",
        )}
        style={{ animationTimingFunction: easing }} />
    </div>
  );
}