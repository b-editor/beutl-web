"use client";

import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { remToPx } from "@/lib/client-utils";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { useTranslation } from "@/app/i18n/client";

function getFeatures(t: ReturnType<typeof useTranslation>["t"]) {
  return [
    {
      name: "features-cross-platform",
      text: t("main:crossPlatform"),
    },
    {
      name: "features-animation",
      text: t("main:animation"),
    },
    {
      name: "features-effects",
      text: t("main:richEffects"),
    },
    {
      name: "features-extensions",
      text: t("main:extensible"),
    },
  ];
}

export default function FeaturesToc({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const features = getFeatures(t);
  const [selected, setSelected] = useState<string | undefined>();
  const ticking = useRef(false);
  const router = useRouter();

  const onscroll = useCallback(() => {
    const elms: [number, Element][] = Array.from(
      document.querySelectorAll(".features-header"),
    ).map((i) => [i.getBoundingClientRect().top, i]);

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
      if (prevTop <= top && nextTop > top) {
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

  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (event.target instanceof HTMLElement) {
        const value = event.target.getAttribute("value");
        if (value) {
          router.push(`#${value}`);
        }
      }
    },
    [router],
  );

  return (
    <div className="flex items-center justify-center md:sticky mx-auto p-3 flex-wrap top-[calc(3.5rem+1px)] z-10 bg-[hsl(var(--card)/60%)] gap-2 backdrop-blur-lg">
      {features.map((feature) => (
        <Button
          key={feature.name}
          onClick={handleClick}
          value={feature.name}
          variant={selected === feature.name ? "secondary" : "ghost"}
        >
          {feature.text}
        </Button>
      ))}
    </div>
  );
}
