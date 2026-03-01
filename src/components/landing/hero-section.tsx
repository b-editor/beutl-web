"use client";

import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import FloatingElements from "./floating-elements";
import styles from "@/styles/hero-gradient.module.css";

function HeroGradientMesh() {
  return (
    <div className={styles.meshContainer}>
      <div className={styles.blob1} />
      <div className={styles.blob2} />
      <div className={styles.blob3} />
    </div>
  );
}

interface HeroTexts {
  unleashCreativity: string;
  freeAndOpenSource: string;
  download: string;
}

export default function HeroSection({
  texts,
}: {
  texts: HeroTexts;
}) {
  const prefersReducedMotion = useReducedMotion();

  const fadeInUp = (delay: number) =>
    prefersReducedMotion
      ? {}
      : {
          initial: { opacity: 0, y: 30 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, ease: "easeOut" as const, delay },
        };

  return (
    <section className="relative overflow-hidden min-h-[85vh] flex flex-col justify-center">
      <HeroGradientMesh />

      <div className="container mx-auto px-6 pt-12 md:px-12 relative z-10">
        <motion.h1
          {...fadeInUp(0)}
          className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl lg:mt-8"
        >
          {texts.unleashCreativity}
        </motion.h1>
        <motion.h2
          {...fadeInUp(0.1)}
          className="scroll-m-20 mt-8 pb-2 text-xl md:text-3xl font-medium tracking-tight"
        >
          {texts.freeAndOpenSource}
        </motion.h2>
        <motion.div {...fadeInUp(0.2)} className="mt-6 flex gap-4">
          <Button
            className={`border bg-gradient-to-r from-primary via-primary/80 to-primary hover:shadow-[0_0_20px_hsl(244_86%_57%/0.4)] transition-shadow`}
            asChild
          >
            <Link href="https://github.com/b-editor/beutl/releases/latest">
              <Download className="w-5 h-5 mr-2" />
              {texts.download}
            </Link>
          </Button>
          <Button
            variant="link"
            className="text-foreground border backdrop-brightness-75 hover:shadow-[0_0_15px_hsl(0_0%_100%/0.15)] transition-shadow"
            asChild
          >
            <Link href="https://github.com/b-editor/beutl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/img/github-color.svg"
                alt="GitHub"
                className="w-5 h-5 mr-2 invert"
              />
              GitHub
            </Link>
          </Button>
        </motion.div>

        <motion.div
          {...(prefersReducedMotion
            ? {}
            : {
                initial: { opacity: 0, scale: 0.95, y: 20 },
                animate: { opacity: 1, scale: 1, y: 0 },
                transition: { duration: 0.8, ease: "easeOut" as const, delay: 0.3 },
              })}
          className="relative mt-16 md:mt-8 mx-auto select-none pointer-events-none"
        >
          <FloatingElements />
          <Image
            className="scale-[107.5%]"
            src="/img/brand-image2.png"
            alt="brand image"
            width={1920}
            height={1080}
            priority
          />
        </motion.div>
      </div>
    </section>
  );
}
