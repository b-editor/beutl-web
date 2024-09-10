import styles from "@/app/styles.module.css"
import { cn } from "@/lib/utils";

export default function EasingDemo({ path, easing, type }: { path: string, easing: string, type: "in" | "out" | "inOut" }) {
  return (
    <div className={cn(styles.easingDemo, "relative")}>
      <svg className="overflow-visible" viewBox="0 0 125 85" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {type === "in" &&
            <linearGradient id="in" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="hsl(var(--foreground))" />
              <stop offset="50%" stopColor="hsl(var(--foreground))" />
              {/* <stop offset="70%" stopColor="color-mix(in hsl, hsl(var(--primary)), white 15%)" />
              <stop offset="100%" stopColor="color-mix(in hsl, hsl(var(--primary)), white 15%)" /> */}
              <stop offset="70%" stopColor="hsl(var(--primary))" />
              <stop offset="100%" stopColor="hsl(var(--primary))" />
            </linearGradient>}
          {type === "out" &&
            <linearGradient id="out" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="hsl(var(--primary))" />
              <stop offset="30%" stopColor="hsl(var(--primary))" />
              <stop offset="50%" stopColor="hsl(var(--foreground))" />
              <stop offset="100%" stopColor="hsl(var(--foreground))" />
            </linearGradient>}
          {type === "inOut" &&
            <linearGradient id="inOut" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="hsl(var(--foreground))" />
              <stop offset="20%" stopColor="hsl(var(--primary))" />
              <stop offset="80%" stopColor="hsl(var(--primary))" />
              <stop offset="100%" stopColor="hsl(var(--foreground))" />
            </linearGradient>}
        </defs>
        <g>
          <path d="M1 0v84h124" strokeLinecap="round" strokeWidth="2" fill="none" stroke="#ffffff">
          </path>
        </g>
        <path className="translate-x-[1px] translate-y-[-1px]"
          strokeLinecap="round" d={path}
          strokeWidth="2" fill="none" stroke={`url(#${type})`} />
      </svg>
      <div
        className={cn(styles.easingDemoMeter, "bg-primary w-2 h-2 rounded absolute top-full -right-3 -translate-y-[5.5px] will-change-[top]")}
        style={{ animationTimingFunction: easing }} />
    </div>
  );
}