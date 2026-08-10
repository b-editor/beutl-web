import type { NextPageContext } from "next";

// Pages Router の _error を明示実装し、Next.js の自動生成が
// HtmlContext チャンクを誤って解決する既知バグ (15.5.x) を回避する。
function ErrorPage(props: { statusCode?: number }) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p style={{ color: "#666" }}>
        {props.statusCode
          ? `An error ${props.statusCode} occurred on server`
          : "An error occurred on client"}
      </p>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
