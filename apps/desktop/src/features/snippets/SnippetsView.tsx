import { Notice } from "../../components/ui/controls";
import { msg } from "../../lib/messages";
import { SnippetLibrary } from "./SnippetLibrary";

/** The Snippets page: library management. Running happens from the panel beside a terminal. */
export function SnippetsView() {
  return (
    <div className="page">
      <section className="page-inner" aria-labelledby="snippets-title" style={{ maxWidth: 860 }}>
        <div className="page-header">
          <div className="page-title">
            <h1 id="snippets-title">{msg.snippets.title}</h1>
            <p>{msg.snippets.subtitle}</p>
          </div>
        </div>
        <Notice tone="info">{msg.snippets.targetNone}</Notice>
        <SnippetLibrary target={null} compact={false} />
      </section>
    </div>
  );
}
