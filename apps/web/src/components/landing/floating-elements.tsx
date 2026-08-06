import styles from "@/styles/hero-gradient.module.css";

export default function FloatingElements() {
  return (
    <div className="absolute inset-0 pointer-events-none select-none overflow-hidden">
      {/* Timeline ruler - top left */}
      <svg
        className={`${styles.floatSlow} absolute -top-4 -left-8 md:left-4 opacity-20 w-28 h-8`}
        viewBox="0 0 120 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="0" y="12" width="120" height="8" rx="2" fill="hsl(244 86% 57%)" />
        {[0, 15, 30, 45, 60, 75, 90, 105, 120].map((x) => (
          <rect key={x} x={x} y="4" width="1.5" height={x % 30 === 0 ? 24 : 16} fill="hsl(244 86% 70%)" />
        ))}
      </svg>

      {/* Keyframe diamond - top right */}
      <svg
        className={`${styles.floatMedium} absolute top-2 -right-4 md:right-8 opacity-25 w-8 h-8`}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M12 2L22 12L12 22L2 12Z" fill="hsl(280 80% 55%)" />
      </svg>

      {/* Layer stack - right side */}
      <svg
        className={`${styles.floatFast} absolute top-1/3 -right-6 md:right-0 opacity-20 w-12 h-16`}
        viewBox="0 0 48 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="4" y="8" width="36" height="12" rx="3" fill="hsl(190 80% 50%)" opacity="0.6" />
        <rect x="0" y="26" width="36" height="12" rx="3" fill="hsl(244 86% 57%)" opacity="0.8" />
        <rect x="8" y="44" width="36" height="12" rx="3" fill="hsl(280 80% 55%)" opacity="0.6" />
      </svg>

      {/* Small keyframe diamond - bottom left */}
      <svg
        className={`${styles.floatMedium} absolute bottom-8 left-4 md:left-16 opacity-20 w-5 h-5`}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M12 2L22 12L12 22L2 12Z" fill="hsl(190 80% 50%)" />
      </svg>

      {/* Play button - bottom right */}
      <svg
        className={`${styles.floatSlow} absolute bottom-4 right-4 md:right-20 opacity-15 w-10 h-10`}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="20" cy="20" r="18" stroke="hsl(244 86% 70%)" strokeWidth="2" />
        <path d="M16 12L30 20L16 28Z" fill="hsl(244 86% 70%)" />
      </svg>
    </div>
  );
}
