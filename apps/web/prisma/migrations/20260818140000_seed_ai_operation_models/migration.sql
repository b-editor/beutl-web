-- 操作ごとのモデルと単価を AiOperationModel に一本化する。
--
-- ここまでは AiSetting の `model.<op>` / `price.<op>` が「行が無い操作の
-- フォールバック」として生きていたが、管理画面には両方が並び、行を 1 つでも
-- 登録すると上の欄は黙って無視されるという状態だった。効かない入力欄を
-- 残さないため、全操作に行を 1 つずつ作ってテーブル側だけを設定場所にする。
--
-- 各行の値は「管理者が設定していればその値、無ければ組み込みの既定値」。
-- 下の VALUES は 2026-08-18 時点の packages/core/src/ai-settings.ts の
-- AI_DEFAULT_OPERATION_MODELS のスナップショット。
--
-- 既に登録済みの操作は触らない (NOT EXISTS)。本番にこのテーブルはまだ無いが、
-- 開発クラスタで手作業の行がある場合に上書きしないため。
INSERT INTO "AiOperationModel" (
    "operation", "modelId", "priceUnits", "displayName",
    "sortOrder", "enabled", "updatedBy", "updatedAt", "createdAt"
)
SELECT
    d.operation,
    COALESCE(
        (SELECT s."value" FROM "AiSetting" s WHERE s."key" = 'model.' || d.operation),
        d.model
    ),
    COALESCE(
        (SELECT s."value"::INT FROM "AiSetting" s WHERE s."key" = 'price.' || d.operation),
        d.price
    ),
    NULL,
    0,
    true,
    NULL,
    current_timestamp(),
    current_timestamp()
FROM (
    VALUES
        ('image.generate', 'openai/gpt-image-1', 20),
        ('image.edit.remove_background', 'openai/gpt-image-1', 10),
        ('image.edit.upscale', 'bytedance-seed/seedream-4.5', 15),
        ('image.edit.restyle', 'openai/gpt-image-1', 20),
        ('image.edit.remove_object', 'openai/gpt-image-1', 20),
        ('image.edit.outpaint', 'openai/gpt-image-1', 20),
        ('audio.transcribe', 'openai/whisper-large-v3-turbo', 5),
        ('subtitle.translate', 'openai/gpt-4.1-mini', 5),
        ('video.generate', 'google/veo-3.1', 40)
) AS d(operation, model, price)
WHERE NOT EXISTS (
    SELECT 1 FROM "AiOperationModel" m WHERE m."operation" = d.operation
);

-- 元の AiSetting 行は消さない。新しいコードはこれらのキーを読まないので害は
-- 無く、残しておけばデプロイを巻き戻したときに以前の単価がそのまま復活する。
-- 掃除は、切り戻しの可能性が無くなってから別のマイグレーションで行う。
