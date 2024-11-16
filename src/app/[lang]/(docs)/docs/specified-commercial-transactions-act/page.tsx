export default function Page() {
  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h2 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        特定商取引法に基づく表記
      </h2>
      <table className="w-full">
        <tbody>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              販売業社の名称
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              寺田雄翔
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              所在地
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              請求があったら遅滞なく開示します
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              電話番号
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              請求があったら遅滞なく開示します
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              メールアドレス
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              contact@mail.beditor.net
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              運営統括責任者
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              寺田雄翔
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              引渡時期
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              決済確認後、即時ダウンロード可能です。
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              受け付け可能な決済手段
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              クレジットカード
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              決済期間
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              クレジットカード決済の場合はただちに処理されます。
            </td>
          </tr>
          <tr className="m-0 border-t p-0">
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              販売価格
            </td>
            <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
              各商品のページに記載しております。
            </td>
          </tr>
        </tbody>
      </table>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        交換および返品（返金ポリシー）
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        商品の性質上、返品・交換はお受けしておりません。
      </p>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        ただし、以下の場合には対応いたします：
      </p>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>
          ダウンロード商品が正常にダウンロードできない場合
        </li>
        <li>
          提供された商品が破損、または著しく異なる場合
        </li>
      </ul>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        上記の場合は、商品購入後7日以内にサポート窓口（contact@mail.beditor.net）までご連絡ください。
      </p>
      
      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        ソフトウェアの動作環境
      </h3>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>
          Windows 10 以上, x64
        </li>
        <li>
          macOS 14.0 以上
        </li>
        <li>
          Ubuntu 22.04
        </li>
      </ul>
    </div>
  )
}