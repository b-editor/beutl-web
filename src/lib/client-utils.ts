export function remToPx(rem: number) {
  const fontSize = getComputedStyle(document.documentElement).fontSize;
  return rem * Number.parseFloat(fontSize);
}
