import { cn } from "@beutl/core";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target={props.href?.startsWith("#") ? undefined : "_blank"}
      rel="nofollow noopener noreferrer ugc"
    />
  ),
  img: ({ node: _node, ...props }) =>
    props.src ? (
      // Markdown images have author-provided URLs and dimensions.
      // eslint-disable-next-line @next/next/no-img-element
      <img {...props} alt={props.alt ?? ""} loading="lazy" decoding="async" />
    ) : (
      <span>{props.alt}</span>
    ),
  table: ({ node: _node, ...props }) => (
    <div className="my-4 max-w-full overflow-x-auto">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 break-words leading-7",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold",
        "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold",
        "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
        "[&_h4]:mt-4 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold",
        "[&_p]:my-3 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
        "[&_.task-list-item]:list-none [&_input[type=checkbox]]:mr-2",
        "[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm",
        "[&_pre]:my-4 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/50 [&_pre]:p-4",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_th]:border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:px-3 [&_td]:py-2",
        "[&_hr]:my-6 [&_hr]:border-border [&_img]:my-4 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
