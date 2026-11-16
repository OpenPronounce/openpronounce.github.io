"""Build the static site: wraps every page of _pages/ in the shared layout.

    python3 build.py            # writes the HTML files next to this script
    python3 -m http.server 8080 # then open http://localhost:8080

A page in _pages/ starts with one line of JSON metadata inside an HTML comment:
    <!-- {"title": "...", "description": "...", "nav": "docs"} -->
Its path under _pages/ is its path on the site. Standard library only.
"""

import html
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.join(ROOT, "_pages")
SITE = "https://openpronounce.github.io"

DOCS = [
    ("Getting started", [("docs/index.html", "Introduction"), ("docs/install.html", "Installation")]),
    ("Using it", [("docs/read-speech.html", "A sentence to read"), ("docs/free-speech.html", "Free speech"),
                  ("docs/results.html", "Reading a result"), ("docs/http-api.html", "HTTP API and Docker"),
                  ("docs/configuration.html", "Configuration")]),
    ("Trusting it", [("docs/evaluate.html", "Measure it on your data"), ("docs/languages.html", "Languages"),
                     ("docs/limits.html", "What it does not do"), ("docs/how-it-works.html", "How it works")]),
    ("Licensing", [("docs/licensing.html", "Which licence you need"), ("docs/commercial-licence.html", "Commercial licence terms")]),
]

LOGO = ('<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="var(--ink)"/>'
        '<path d="M5 14.5c1.6-2.4 3.2-2.4 4.7 0s3.1 2.4 4.6 0 3.1-2.4 4.7 0" stroke="var(--red)" stroke-width="2.2" '
        'fill="none" stroke-linecap="round"/></svg>')

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)">
<link rel="icon" href="{root}assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Charis+SIL&family=Caveat:wght@500;600&display=swap">
<link rel="stylesheet" href="{root}assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="{root}index.html">{logo}OpenPronounce</a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav class="nav" id="nav" aria-label="Main">
      <a href="{root}developers.html"{cur_dev}>Developers</a>
      <a href="{root}teams.html"{cur_teams}>For teams</a>
      <a href="{root}docs/index.html"{cur_docs}>Docs</a>
      <a href="{root}faq.html"{cur_faq}>FAQ</a>
      <a href="{root}pricing.html"{cur_pricing}>Pricing</a>
      <a href="https://github.com/Halleck45/OpenPronounce">GitHub</a>
      <a class="btn" href="{root}developers.html">Install</a>
    </nav>
  </div>
</header>
<main id="main">
"""

FOOT = """</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="foot">
      <div>
        <a class="logo" href="{root}index.html">{logo}OpenPronounce</a>
        <p>Pronunciation assessment that runs on your own servers. Open source, code and models.</p>
      </div>
      <div><h4>Product</h4><ul>
        <li><a href="{root}developers.html">Installation guide</a></li>
        <li><a href="{root}teams.html">For teams</a></li>
        <li><a href="{root}pricing.html">Pricing</a></li>
        <li><a href="https://github.com/Halleck45/OpenPronounce">Source code</a></li>
      </ul></div>
      <div><h4>Docs</h4><ul>
        <li><a href="{root}docs/install.html">Installation</a></li>
        <li><a href="{root}docs/results.html">Reading a result</a></li>
        <li><a href="{root}docs/evaluate.html">Measure it on your data</a></li>
        <li><a href="{root}docs/limits.html">What it does not do</a></li>
        <li><a href="{root}faq.html">Questions and answers</a></li>
        <li><a href="{root}governance.html">Governance</a></li>
      </ul></div>
      <div><h4>Licence</h4><ul>
        <li><a href="{root}docs/licensing.html">Which licence you need</a></li>
        <li><a href="{root}buy.html">Buy a licence</a></li>
        <li><a href="{root}contact.html">Contact</a></li>
      </ul></div>
    </div>
    <div class="foot-base"><span>&copy; 2026 The OpenPronounce authors. Code and models under the AGPL-3.0 or a commercial licence.</span><span>Benchmarks on speechocean762 (CC BY 4.0).</span></div>
  </div>
</footer>
<script src="{root}assets/config.js"></script>
{scripts}<script src="{root}assets/site.js"></script>
</body>
</html>
"""


def docs_layout(path, body, root):
    flat = [item for _, items in DOCS for item in items]
    links = []
    for group, items in DOCS:
        current = ' aria-current="page"'
        lis = "".join(f'<li><a href="{root}{p}"{current if p == path else ""}>{html.escape(t)}</a></li>'
                      for p, t in items)
        links.append(f"<div><h4>{group}</h4><ul>{lis}</ul></div>")
    i = [p for p, _ in flat].index(path)
    pager = ""
    if i > 0:
        pager += f'<a class="prev" href="{root}{flat[i - 1][0]}"><small>Previous</small>{flat[i - 1][1]}</a>'
    if i < len(flat) - 1:
        pager += f'<a class="next" href="{root}{flat[i + 1][0]}"><small>Next</small>{flat[i + 1][1]}</a>'
    return (f'<div class="wrap"><div class="docs"><nav class="docs-nav" aria-label="Documentation">{"".join(links)}</nav>'
            f'<article class="doc">{body}<div class="pager">{pager}</div></article></div></div>')


def build():
    written = []
    for folder, _, files in os.walk(PAGES):
        for name in sorted(files):
            if not name.endswith(".html"):
                continue
            src = os.path.join(folder, name)
            path = os.path.relpath(src, PAGES).replace(os.sep, "/")
            text = open(src, encoding="utf-8").read()
            meta_line, body = text.split("\n", 1)
            meta = json.loads(re.match(r"<!--\s*(\{.*\})\s*-->", meta_line).group(1))
            root = "../" * path.count("/")
            body = body.replace("{{root}}", root)
            if path.startswith("docs/"):
                body = docs_layout(path, body, root)
            nav = meta.get("nav", "")
            cur = {k: (' aria-current="page"' if nav == k else "") for k in ("dev", "teams", "docs", "faq", "pricing")}
            scripts = "".join(f'<script src="{root}{s}"></script>\n' for s in meta.get("scripts", []))
            url = SITE + "/" + ("" if path == "index.html" else path)
            page = (HEAD.format(title=html.escape(meta["title"]), description=html.escape(meta["description"]), url=url,
                                root=root, logo=LOGO, **{f"cur_{k}": v for k, v in cur.items()})
                    + body + FOOT.format(root=root, logo=LOGO, scripts=scripts))
            out = os.path.join(ROOT, path)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                f.write(page)
            written.append(path)
    pages = sorted(p for p in written if p != "404.html")
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        f.writelines(f"  <url><loc>{SITE}/{'' if p == 'index.html' else p}</loc></url>\n" for p in pages)
        f.write("</urlset>\n")
    print(f"{len(written)} pages written")


if __name__ == "__main__":
    build()
