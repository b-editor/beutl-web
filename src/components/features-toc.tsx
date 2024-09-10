"use client";

import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { remToPx } from "@/lib/client-utils";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";

const features = [
  {
    name: "features-cross-platform",
    text: "クロスプラットフォーム"
  },
  {
    name: "features-animation",
    text: "アニメーション"
  },
  {
    name: "features-effects",
    text: "エフェクト"
  },
  {
    name: "features-extensions",
    text: "拡張機能"
  }
];

export default function FeaturesToc() {
  const [selected, setSelected] = useState<string | undefined>();
  const ticking = useRef(false);
  const router = useRouter();

  const onscroll = useCallback(() => {
    const elms: [number, Element][] = Array.from(document.querySelectorAll(".features-header"))
      .map(i => [i.getBoundingClientRect().top, i]);

    const top = remToPx(3.5 + 4) + window.innerHeight / 2;

    for (let i = 1; i < elms.length; i++) {
      const [prevTop, prevElm] = elms[i - 1];
      const [nextTop, nextElm] = elms[i];

      if (top < prevTop && i === 1) {
        if (selected !== undefined) {
          router.replace("", { scroll: false });
        }
        setSelected(undefined);
        break;
      }
      if ((prevTop <= top && nextTop > top)) {
        if (selected !== prevElm.id) {
          router.replace(`#${prevElm.id}`, { scroll: false });
        }
        setSelected(prevElm.id);
        break;
      }
      if (i === elms.length - 1) {
        if (selected !== nextElm.id) {
          router.replace(`#${nextElm.id}`, { scroll: false });
        }
        setSelected(nextElm.id);
      }
    }
  }, [router, selected]);

  useEffect(() => {
    const handler = () => {
      if (!ticking.current) {
        window.requestAnimationFrame(() => {
          onscroll();
          ticking.current = false;
        });

        ticking.current = true;
      }
    };
    window.addEventListener("scroll", handler);
    onscroll();

    return () => {
      window.removeEventListener("scroll", handler);
    };
  }, [onscroll]);

  const handleClick = useCallback((event: MouseEvent) => {
    if (event.target instanceof HTMLElement) {
      const value = event.target.getAttribute("value");
      if (value) {
        router.push(`#${value}`);
      }
    }
  }, [router]);

  return (
    <div className="flex items-center justify-center md:sticky mx-auto p-3 flex-wrap top-[calc(3.5rem+1px)] z-10 bg-[hsl(var(--card)/60%)] gap-2 backdrop-blur-lg">
      {features.map((feature) => (
        <Button key={feature.name} onClick={handleClick}
          value={feature.name} variant={selected === feature.name ? "secondary" : "ghost"}
        >
          {feature.text}
        </Button>
      ))}
    </div>
  );
}