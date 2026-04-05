"use client";

import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";

interface MessageBubbleProps {
  message: UIMessage;
}

/**
 * Renders inline markdown:
 * - **bold**
 * - `code`
 * - # headings (h1–h3)
 * - - list items
 * - ```code blocks```
 */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre
          key={i}
          className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-sm font-mono"
          data-lang={lang || undefined}
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      i++; // skip closing ```
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      const headingClasses = {
        h1: "mt-4 mb-1 text-xl font-bold",
        h2: "mt-3 mb-1 text-lg font-semibold",
        h3: "mt-2 mb-1 text-base font-semibold",
      }[Tag];
      nodes.push(
        <Tag key={i} className={headingClasses}>
          {renderInline(content)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Unordered list item
    if (/^[\s]*[-*+]\s/.test(line)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*[-*+]\s/, "");
        listItems.push(
          <li key={i} className="ml-4 list-disc">
            {renderInline(itemText)}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-1 space-y-0.5">
          {listItems}
        </ul>,
      );
      continue;
    }

    // Ordered list item
    if (/^[\s]*\d+\.\s/.test(line)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*\d+\.\s/, "");
        listItems.push(
          <li key={i} className="ml-4 list-decimal">
            {renderInline(itemText)}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-1 space-y-0.5">
          {listItems}
        </ol>,
      );
      continue;
    }

    // Blank line — paragraph break
    if (line.trim() === "") {
      nodes.push(<div key={i} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph line
    nodes.push(
      <p key={i} className="leading-relaxed">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return nodes;
}

function renderInline(text: string): React.ReactNode {
  // Split on **bold**, `code`, and plain text
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded bg-muted px-1 py-0.5 font-mono text-sm"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  // Extract text content from parts
  const textContent = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{textContent}</span>
        ) : (
          <div className="prose-sm">{renderMarkdown(textContent)}</div>
        )}
      </div>
    </div>
  );
}
