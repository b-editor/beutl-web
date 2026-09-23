// Provider metadata does not describe every request option. These are
// administrator-selected behaviors of one registered operation/model row,
// never inferred from its model ID.
export const AI_IMAGE_SIZE_MODES = ["aspect_ratio", "explicit_1k"] as const;
export type AiImageSizeMode = (typeof AI_IMAGE_SIZE_MODES)[number];

export const AI_IMAGE_OUTPUT_TOKEN_PROFILES = ["legacy", "grid_48_medium"] as const;
export type AiImageOutputTokenProfile = (typeof AI_IMAGE_OUTPUT_TOKEN_PROFILES)[number];
