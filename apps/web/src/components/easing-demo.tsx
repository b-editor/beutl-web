/**
 * Curves are sampled from the real easing functions rather than hand-drawn, so
 * each card shows the shape it is named after: Back overshoots and settles back,
 * Bounce lands in decreasing hops, Elastic oscillates past the target.
 */
const CURVE_X0 = 4;
const CURVE_W = 117;
/** y for value 0 and value 1. Overshoot past 1 rises above CURVE_Y1. */
const CURVE_Y0 = 88;
const CURVE_Y1 = 8;

function sample(fn: (t: number) => number, steps = 96) {
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = CURVE_X0 + t * CURVE_W;
    const y = CURVE_Y0 + fn(t) * (CURVE_Y1 - CURVE_Y0);
    points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `M${points.join("L")}`;
}

function bounceOut(t: number) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

export const EASING_CURVES = {
  easeIn: sample((t) => t * t * t),
  easeInOut: sample((t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  ),
  easeOut: sample((t) => 1 - Math.pow(1 - t, 3)),
  easeElastic: sample((t) =>
    t === 0 || t === 1
      ? t
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) +
        1,
  ),
  easeBack: sample((t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }),
  easeBounce: sample(bounceOut),
};

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
        viewBox="0 -30 125 150"
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
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-[10.5px] font-bold tracking-[0.04em] text-lp-faint">
        {label}
      </span>
    </div>
  );
}
