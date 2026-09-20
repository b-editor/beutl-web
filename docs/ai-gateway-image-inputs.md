# Gateway image-input compatibility

Checked against Vercel's model pages on 2026-09-21. The Gateway model API
currently reports text-only input modalities for documented image editors,
and its generic SDK image prompt does not establish support in an individual
model. `gatewayImageCapabilities` therefore uses exact model IDs with explicit
image-input allowances. Unlisted models receive `inputReferences: false` and
`maxReferenceImages: 0`; their plain text-to-image capability is unchanged.

These are this service's conservative allowances, capped at four images,
not a claim about every provider's full maximum. Kontext is limited to a
single source for its documented iterative editing workflow.

| Model ID | Allowed source/reference images | Evidence |
| --- | ---: | --- |
| `openai/gpt-image-1` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/gpt-image-1) |
| `openai/gpt-image-1.5` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/gpt-image-1.5) |
| `openai/gpt-image-2` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/gpt-image-2) |
| `bfl/flux-2-pro` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/flux-2-pro) |
| `bfl/flux-2-flex` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/flux-2-flex) |
| `bfl/flux-kontext-pro` | 1 | [Vercel model page](https://vercel.com/ai-gateway/models/flux-kontext-pro) |
| `bfl/flux-kontext-max` | 1 | [Vercel model page](https://vercel.com/ai-gateway/models/flux-kontext-max) |
| `bytedance/seedream-4.0` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/seedream-4.0) |
| `bytedance/seedream-4.5` | 4 | [Vercel model page](https://vercel.com/ai-gateway/models/seedream-4.5) |
| `spacexai/grok-imagine-image` | 3 | [Vercel model page](https://vercel.com/ai-gateway/models/grok-imagine-image) |

Before adding an ID or increasing its allowance, verify that the Gateway
supports the adapter's plain `prompt: { text, images }` path for that exact
model. A mask-only editing endpoint or support on another provider is not
sufficient. Update this evidence and the capability tests together. Do not
infer support from a family prefix or from the SDK's generic request type.
