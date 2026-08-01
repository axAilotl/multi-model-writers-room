import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...properties }) => {
            const external = href !== undefined && /^https?:\/\//i.test(href);
            return (
              <a
                {...properties}
                href={href}
                {...(external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt, title }) => {
            const localSource = typeof src === "string" &&
              /^(?:\/(?!\/)|\.\.?\/)/.test(src);
            if (localSource) {
              return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
            }
            const remoteSource = typeof src === "string" &&
              /^(?:https?:)?\/\//i.test(src);
            if (remoteSource) {
              return (
                <a
                  className="markdown-remote-image"
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={title}
                >
                  Image: {alt || src}
                </a>
              );
            }
            return <span className="markdown-image-unavailable">Image unavailable</span>;
          }
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
