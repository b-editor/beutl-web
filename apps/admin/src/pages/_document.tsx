import Document, {
  Html,
  Head,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from "next/document";

// Pages Router の _document を明示実装し、Next.js 15.5.x の既知バグ
// (自動生成 _document が HtmlContext チャンク解決を誤る) を回避する。
// このプロジェクトは App Router が主なので、Pages Router は _error 専用。
class BeutlDocument extends Document {
  static async getInitialProps(
    ctx: DocumentContext,
  ): Promise<DocumentInitialProps> {
    const initialProps = await Document.getInitialProps(ctx);
    return { ...initialProps };
  }

  render() {
    return (
      <Html lang="ja" className="dark">
        <Head />
        <body className="antialiased">
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default BeutlDocument;
