"use client";

import { motion, type Variants, useReducedMotion } from "framer-motion";
import { type ReactNode, useEffect, useState } from "react";

/**
 * The transition lives on the component rather than the variant so that it can
 * be reduced to an instant cut; a transition declared on the variant would take
 * precedence over the component's.
 */
const sectionVariants: Variants = {
  hidden: { opacity: 0, y: 40 },
  visible: { opacity: 1, y: 0 },
};

export default function AnimatedSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  // useReducedMotion reads matchMedia during the first client render, which the
  // server cannot know about. Branching on it before mount would leave the
  // hydrated styles disagreeing with the server-rendered ones, and React does
  // not patch up such a mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-100px" }}
      variants={sectionVariants}
      transition={
        mounted && prefersReducedMotion
          ? { duration: 0 }
          : { duration: 0.6, ease: "easeOut" }
      }
      className={className}
    >
      {children}
    </motion.div>
  );
}
