// P-30 notes: the Markdown reader. Negative cases first: markup, scripts, unsafe link schemes and
// remote images in a note never become anything but text. Pure functions, no browser.
import { expect, test } from "@playwright/test";

import { type Block, type Inline, linksOf, noteLink, parseInline, parseMarkdown, pasteText } from "../../apps/desktop/src/features/notes/markdown";

/** Every text a parsed note shows, flattened (what the user would read). */
function textOf(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string =>
    nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "image" ? n.alt : inline(n.c))).join("");
  return blocks
    .map((b) =>
      b.t === "p" || b.t === "h" ? inline(b.c) : b.t === "code" ? b.text : b.t === "list" ? b.items.map(inline).join("\n") : b.t === "quote" ? textOf(b.c) : "",
    )
    .join("\n");
}

test("notes markdown: HTML and scripts stay text", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src="https://tracker.example/p.gif" onerror="alert(1)">',
    "<iframe src=javascript:alert(1)></iframe>",
    '<a href="javascript:alert(1)">click</a>',
    "<svg onload=alert(1)>",
    "<style>body{display:none}</style>",
  ];
  for (const source of hostile) {
    const blocks = parseMarkdown(source);
    // The markup is shown literally, and nothing in it is a link.
    expect(textOf(blocks)).toBe(source);
    expect(linksOf(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).not.toMatch(/"t":"(html|raw)"/);
  }
});

test("notes markdown: javascript:, data:, file: and other schemes are never links", () => {
  const refused = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "file://C:/Windows/win.ini",
    "vbscript:msgbox(1)",
    "smb://share/x",
    "tyrminal://open",
    "/relative/path",
    "//evil.example/x",
    "https://bank.example@evil.example/",
    "https://evil.example\\@bank.example",
    "https://ex\u202Emoc.elpmaxe",
    "https://",
    "ssh://host/run-this",
    "ssh://host?cmd=rm",
    "ssh://-oProxyCommand=x",
    "ssh://host:99999",
    "ssh://us er@host",
  ];
  for (const url of refused) expect(noteLink(url), url).toBeNull();

  for (const source of ["[click](javascript:alert(1))", "[file](file:///etc/passwd)", "<javascript:alert(1)>", "[x](data:text/html,hi)"]) {
    const blocks = parseMarkdown(source);
    expect(linksOf(blocks), source).toEqual([]);
  }
  // The text of a refused link stays readable.
  expect(textOf(parseMarkdown("[click me](javascript:alert(1))"))).toBe("click me");
});

test("notes markdown: images are never loaded, only described", () => {
  const blocks = parseMarkdown("Rack: ![front of rack](https://cdn.example/rack.png) and ![](file:///etc/x.png)");
  const para = blocks[0];
  expect(para?.t).toBe("p");
  const images = para?.t === "p" ? para.c.filter((n) => n.t === "image") : [];
  expect(images).toEqual([
    { t: "image", alt: "front of rack" },
    { t: "image", alt: "" },
  ]);
  // No image node carries a source, and the image URL is not offered as a link either.
  expect(JSON.stringify(blocks)).not.toContain("cdn.example");
  expect(linksOf(blocks)).toEqual([]);
});

test("notes markdown: http, https and ssh links are offered for a click", () => {
  expect(noteLink("https://wiki.example/runbook#db")).toEqual({ kind: "web", url: "https://wiki.example/runbook#db", host: "wiki.example" });
  expect(noteLink("http://10.0.0.5:8080/status")).toMatchObject({ kind: "web", host: "10.0.0.5" });
  expect(noteLink("ssh://deploy@db1.example:2222")).toEqual({ kind: "ssh", url: "ssh://deploy@db1.example:2222", host: "db1.example", port: 2222, username: "deploy" });
  expect(noteLink("ssh://[2001:db8::1]")).toMatchObject({ kind: "ssh", host: "2001:db8::1", port: null, username: null });

  const blocks = parseMarkdown("See [the runbook](https://wiki.example/runbook), <ssh://ops@bastion.example> or https://status.example/now.");
  expect(linksOf(blocks).map((l) => l.url)).toEqual(["https://wiki.example/runbook", "ssh://ops@bastion.example", "https://status.example/now"]);
});

test("notes markdown: structure, code blocks and pasting without Enter", () => {
  const blocks = parseMarkdown("# Web\n\nRestart with **care**, _then_ check `uptime`.\n\n- one\n- two\n\n```sh\nsudo systemctl restart app\nsystemctl status app\n\n```\n> quoted\n\n---");
  expect(blocks.map((b) => b.t)).toEqual(["h", "p", "list", "code", "quote", "hr"]);
  const code = blocks[3];
  expect(code).toEqual({ t: "code", lang: "sh", text: "sudo systemctl restart app\nsystemctl status app\n" });
  expect(pasteText(code?.t === "code" ? code.text : "")).toBe("sudo systemctl restart app\nsystemctl status app");
  expect(parseInline("**bold** and *it*")).toEqual([
    { t: "strong", c: [{ t: "text", v: "bold" }] },
    { t: "text", v: " and " },
    { t: "em", c: [{ t: "text", v: "it" }] },
  ]);
  // Underscores inside identifiers are not emphasis.
  expect(parseInline("set window.__flag = 1, then window.__flag = 2 in snake_case_name")).toEqual([
    { t: "text", v: "set window.__flag = 1, then window.__flag = 2 in snake_case_name" },
  ]);
  // An unclosed fence runs to the end of the note instead of swallowing nothing or everything else.
  expect(parseMarkdown("```\nrm -rf /tmp/x")).toEqual([{ t: "code", lang: "", text: "rm -rf /tmp/x" }]);
});

test("notes markdown: hostile input stays fast", () => {
  const started = Date.now();
  parseMarkdown("[".repeat(60_000));
  parseMarkdown("*_`".repeat(20_000));
  parseMarkdown(">".repeat(60_000));
  parseMarkdown(`${"[a](".repeat(10_000)}x`);
  expect(Date.now() - started).toBeLessThan(2000);
});
