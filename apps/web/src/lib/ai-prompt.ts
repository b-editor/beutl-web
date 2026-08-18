// How the prompt facets a form collects become the one string sent to the
// provider.
//
// It lives outside the Server Action because the length that matters is the
// composed one: the action validates that against MAX_AI_PROMPT_LENGTH, so a
// form counting only its main textarea tells the user they have room they do
// not have, and the submission comes back as a bare "invalid request" next to a
// counter reading 4000 / 4000.

export function composePrompt({
  main,
  style,
  composition,
  motion,
  exclusions,
}: {
  main: string;
  style?: string;
  composition?: string;
  motion?: string;
  exclusions?: string;
}): string {
  const sections: string[] = [];
  const addSection = (label: string | null, value: string | undefined) => {
    const normalized = value?.trim().replace(/\s+/g, " ");
    if (normalized) {
      sections.push(label === null ? normalized : `${label}: ${normalized}`);
    }
  };
  addSection(null, main);
  addSection("Style", style);
  addSection("Composition", composition);
  addSection("Motion", motion);
  addSection("Avoid", exclusions);
  return sections.join("\n");
}
