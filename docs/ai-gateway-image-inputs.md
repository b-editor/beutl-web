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

`openai/gpt-image-2` is also the only model currently verified here for the
background-removal path. [OpenAI documents transparent output for the model](https://developers.openai.com/api/docs/guides/image-generation)
in preview when `background: "transparent"` is paired with PNG or WebP.
[AI Gateway forwards options under the actual provider name](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway#provider-options),
so the adapter requests a transparent PNG and supplies a background-removal
instruction alongside the source image. Other Gateway image models continue
to advertise only `auto` until their transparent-output behavior is verified
independently.

## Outpainting input boundary

Gateway outpainting is supported only by the Web workflow, which expands the
source into a transparent canvas before submitting the edit. The v3 image-edit
API accepts raw source images and does not perform that expansion, so Gateway
outpainting models are omitted from API capabilities and availability and new
requests are rejected before reserving usage or calling the provider. Native
OpenRouter outpainting, other Gateway edits, and retrieval of previously paid
results remain available. Do not re-enable this raw-image API path without
server-side canvas preparation or a validated expanded-input contract.
