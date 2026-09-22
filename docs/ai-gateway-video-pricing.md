# Gateway video pricing compatibility

Checked against Vercel's public catalog and model pages on 2026-09-21.

The admin cost panel must not treat a missing or unfamiliar price as zero. It
therefore reads only pricing shapes whose billing unit can be converted to the
service's per-output-second unit, plus exact fallbacks documented here.

## Seedance 2.0 and 2.5

`GET /v1/models/{id}/endpoints` publishes `video_token_pricing.tiers` for
`bytedance/seedance-2.0` and `bytedance/seedance-2.5`. Each tier names a
resolution and separate per-million-token rates for requests with and without
video input. Vercel's model pages describe the same generated-token unit:

- [Seedance 2.0](https://vercel.com/ai-gateway/models/seedance-2.0)
- [Seedance 2.5](https://vercel.com/ai-gateway/models/seedance-2.5)

The parser converts the published rate with the provider's verified video-token
formula: `width * height * 24 fps / 1024` tokens per second. Only resolutions
the service can request are retained. Generation uses the no-video-input tier;
the source-video operations use the with-video-input tier.
The `2k`/`2K` tier uses the same 2560×1440 default frame as Gateway requests:
86,400 video tokens per second. It participates in the highest applicable tier
used for reservation and affordability checks, rather than falling back to a
cheaper resolution.

## FLUX 3

The public model catalog and endpoint route currently return an empty price for
`bfl/flux-3-video`, although the [Vercel model page](https://vercel.com/ai-gateway/models/flux-3-video)
shows three per-second configurations. Vercel states that
[AI Gateway adds no markup](https://vercel.com/docs/ai-gateway/pricing), and
[Black Forest Labs publishes](https://bfl.ai/pricing) the full-render rates as
$0.17/s for HD and $0.29/s for FHD with text/image input, and $0.41/s for HD
and $0.53/s for FHD with video input.

Those four exact rates are the fallback while Vercel's API fields remain empty.
The adapter does not request the $0.06/s draft mode, so it is excluded.

Before adding a model or changing a fallback, capture its live catalog shape,
verify the billing unit against a primary model page, and update both contract
and opt-in live tests.
