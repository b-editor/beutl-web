import styles from "@/styles/loop-slide.module.css";
import transparentStyles from "@/styles/transparent.module.css";
import growStyles from "@/styles/grow.module.css";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

const effects = [
  {
    name: "ブラー",
  },
  {
    name: "ドロップシャドウ",
  },
  {
    name: "内側シャドウ",
  },
  {
    name: "フラットシャドウ",
  },
  {
    name: "ボーダー",
  },
  {
    name: "ストロークエフェクト",
  },
  {
    name: "クリッピング",
  },
  {
    name: "膨張",
  },
  {
    name: "収縮",
  },
  {
    name: "ハイコントラスト",
  },
  {
    name: "色相回転",
  },
  {
    name: "ライト",
  },
  {
    name: "LumaColor",
  },
  {
    name: "彩度調整",
  },
  {
    name: "二階調化",
  },
  {
    name: "輝度",
  },
  {
    name: "ガンマ",
  },
  {
    name: "反転",
  },
  {
    name: "LUT",
  },
  {
    name: "ブレンド",
  },
  {
    name: "ネガポジ",
  },
  {
    name: "クロマキー",
  },
  {
    name: "カラーキー",
  },
  {
    name: "均等に分割",
  },
  {
    name: "パーツごとに分割",
  },
  {
    name: "トランスフォーム",
  },
  {
    name: "モザイク",
  },
  {
    name: "色ずれ",
  },
];

export default function EffectsDemo() {
  return (  
    // styles.loopSlide, 
    <div className={cn(styles.loopSlide, transparentStyles.transparent, "mt-8 -mx-6 px-6")}>
      <ul className={cn("pt-4 flex flex-wrap justify-between md:justify-center gap-4")}>
        {/* <ul className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8", styles.transparent)}> */}
        {effects.map((item) => (
          <li key={item.name} className={cn(growStyles.listItem, "max-md:flex-auto")}>
            <Card className={growStyles.grow}>
              <CardHeader>  
                <CardTitle className="max-md:text-center">{item.name}</CardTitle>
                {/* <CardDescription>Deploy your new project in one-click.</CardDescription> */}
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
      <ul className={cn("pt-4 flex flex-wrap justify-between md:justify-center gap-4")}>
        {/* <ul className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8", styles.transparent)}> */}
        {effects.map((item) => (
          <li key={item.name} className={cn(growStyles.listItem, "max-md:flex-auto")}>
            <Card className={growStyles.grow}>
              <CardHeader>
                <CardTitle className="max-md:text-center">{item.name}</CardTitle>
                {/* <CardDescription>Deploy your new project in one-click.</CardDescription> */}
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}