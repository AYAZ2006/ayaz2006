#!/usr/bin/env node
/**
 * Generates an animated "pinned repos" terminal-style SVG carousel using
 * a GitHub user's REAL pinned repositories (via GraphQL).
 *
 * Cards crossfade one after another. Each repo name, then its full
 * description (wrapped across up to 3 lines), types out slowly and
 * sequentially, character by character. Once fully typed, the card holds
 * still for a few seconds before crossfading into the next one.
 *
 * Env vars:
 *   GH_USERNAME  - GitHub login to fetch pinned repos for (required)
 *   GH_TOKEN     - token with access to the GraphQL API (required).
 *                  In Actions, the default GITHUB_TOKEN works fine since
 *                  pinned repo data is public.
 *   OUTPUT_PATH  - where to write the SVG (default: dist/github-pinned.svg)
 *   THEME        - "dark" (default) or "light"
 *   MAX_REPOS    - how many pinned repos to include, max 6 (default: 4)
 */

import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUTPUT = process.env.OUTPUT_PATH || "dist/github-pinned.svg";
const THEME = (process.env.THEME || "dark").toLowerCase();
const MAX_REPOS = Math.min(Number(process.env.MAX_REPOS) || 4, 6);

const WIDTH = 513;
const HEIGHT = 205;
const TYPE_CPS = 16; // characters typed per second — deliberately slow/readable
const TYPE_DELAY = 0.15; // pause after a card appears before typing starts
const LINE_GAP = 0.25; // pause between the name finishing and each subsequent line starting
const META_FADE = 0.3; // seconds for language/stars/link to fade in once typing is done
const HOLD_DUR = 4; // seconds the fully-typed card stays still before the next one takes over
const FADE_IN = 0.25;
const FADE_OUT = 0.3;
const CHAR_W = 9.2; // approx monospace advance width at the name's font-size
const DESC_CHAR_W = 6.7; // approx monospace advance width at the description's font-size
const DESC_MAX_CHARS = 62; // wrap width for description lines
const DESC_MAX_LINES = 3;
const FONT = "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";

const PALETTES = {
  dark: {
    bg: "#0d1117",
    cardBg: "#161b22",
    border: "#30363d",
    prompt: "#58a6ff",
    name: "#c9d1d9",
    desc: "#8b949e",
    muted: "#6e7681",
    star: "#e3b341",
    cursor: "#39d353",
  },
  light: {
    bg: "#ffffff",
    cardBg: "#f6f8fa",
    border: "#d0d7de",
    prompt: "#0969da",
    name: "#1f2328",
    desc: "#57606a",
    muted: "#6e7781",
    star: "#9a6700",
    cursor: "#1a7f37",
  },
};

if (!USERNAME) {
  console.error("Missing GH_USERNAME env var");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing GH_TOKEN / GITHUB_TOKEN env var");
  process.exit(1);
}

const QUERY = `
  query($login: String!) {
    user(login: $login) {
      pinnedItems(first: 6, types: [REPOSITORY]) {
        nodes {
          ... on Repository {
            name
            description
            url
            homepageUrl
            stargazerCount
            forkCount
            primaryLanguage {
              name
              color
            }
          }
        }
      }
    }
  }
`;

async function fetchPinned() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user.pinnedItems.nodes;
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1).trimEnd() + "…" : str;
}

function escAttr(str) {
  return esc(str).replace(/"/g, "&quot;");
}

// Greedy word-wrap: fills up to maxLines of maxChars each, adds an ellipsis
// to the last line if the text didn't fully fit.
function wrapText(str, maxChars, maxLines) {
  const words = String(str || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  let usedWords = 0;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    usedWords++;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (usedWords < words.length && lines.length) {
    const last = lines[lines.length - 1].replace(/[.,;:\s]+$/, "");
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function displayUrl(url, max) {
  if (!url) return "";
  const stripped = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return stripped.length > max ? stripped.slice(0, max - 1) + "…" : stripped;
}

function fmt(n) {
  return Number(n.toFixed(4));
}

function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function prepareCard(repo, index, total) {
  const name = truncate(repo.name, 28);
  const descLines = wrapText(
    repo.description || "No description provided",
    DESC_MAX_CHARS,
    DESC_MAX_LINES
  );
  const lang = repo.primaryLanguage;
  const nameWidth = fmt(name.length * CHAR_W);
  const descLineWidths = descLines.map((l) => fmt(l.length * DESC_CHAR_W));
  const homepage = repo.homepageUrl && repo.homepageUrl.trim();

  // Lay out, in local seconds from this card's own start, when each piece
  // of text begins/finishes typing.
  const nameStart = TYPE_DELAY;
  const nameEnd = nameStart + name.length / TYPE_CPS;

  const lineStarts = [];
  const lineEnds = [];
  let cursor = nameEnd + LINE_GAP;
  for (const line of descLines) {
    const start = cursor;
    const end = start + line.length / TYPE_CPS;
    lineStarts.push(start);
    lineEnds.push(end);
    cursor = end + LINE_GAP;
  }
  const lastTypeEnd = descLines.length ? lineEnds[lineEnds.length - 1] : nameEnd;

  const metaStart = lastTypeEnd + LINE_GAP;
  const metaEnd = metaStart + META_FADE;
  const holdEnd = metaEnd + HOLD_DUR;
  const dCard = holdEnd + FADE_OUT;

  return {
    index,
    total,
    repo,
    name,
    descLines,
    descLineWidths,
    lang,
    nameWidth,
    homepage,
    t: { nameStart, nameEnd, lineStarts, lineEnds, metaStart, metaEnd, holdEnd },
    dCard,
  };
}

function buildCard(card, absStart, totalDur, colors) {
  const { index, total, repo, name, descLines, descLineWidths, lang, nameWidth, homepage, t, dCard } = card;
  const frac = (localSec) => fmt((absStart + localSec) / totalDur);

  const cardId = `card${index}`;
  const clipId = `typeclip${index}`;

  // Card visibility: hidden -> fade in -> stay visible for its whole
  // typing+hold duration -> fade out -> hidden.
  const vT0 = frac(0);
  const vT1 = frac(FADE_IN);
  const vT2 = frac(dCard - FADE_OUT);
  const vT3 = frac(dCard);

  const descLinesSvg = descLines
    .map((line, i) => {
      const lineClipId = `${clipId}-line${i}`;
      const y = 78 + i * 15;
      const lineStart = frac(t.lineStarts[i]);
      const lineEnd = frac(t.lineEnds[i]);
      return `<clipPath id="${lineClipId}">
      <rect x="38" y="${y - 12}" height="18" width="0">
        <animate attributeName="width" dur="${totalDur}s" repeatCount="indefinite"
          keyTimes="0;${lineStart};${lineEnd};1"
          values="0;0;${descLineWidths[i]};${descLineWidths[i]}"/>
      </rect>
    </clipPath>
    <g clip-path="url(#${lineClipId})">
      <text x="38" y="${y}" font-family="${FONT}" font-size="11.5" fill="${colors.desc}">${esc(line)}</text>
    </g>`;
    })
    .join("\n    ");

  const lastLineIdx = descLines.length - 1;
  const lastLineWidth = lastLineIdx >= 0 ? descLineWidths[lastLineIdx] : 0;
  const lastLineY = lastLineIdx >= 0 ? 78 + lastLineIdx * 15 : 55;

  const linkSvg = homepage
    ? `<a href="${escAttr(homepage)}" xlink:href="${escAttr(homepage)}" target="_blank">
      <text x="38" y="128" font-family="${FONT}" font-size="10.5" fill="${colors.prompt}" text-decoration="underline">🔗 ${esc(displayUrl(homepage, 56))}</text>
    </a>`
    : "";

  return `
<g id="${cardId}" opacity="0">
  <animate attributeName="opacity" dur="${totalDur}s" repeatCount="indefinite"
    keyTimes="0;${vT0};${vT1};${vT2};${vT3};1"
    values="0;0;1;1;0;0"/>

  <rect x="20" y="24" width="${WIDTH - 40}" height="160" rx="8" ry="8"
    fill="${colors.cardBg}" stroke="${colors.border}" stroke-width="1"/>

  <text x="38" y="55" font-family="${FONT}" font-size="13" fill="${colors.prompt}">$</text>

  <clipPath id="${clipId}">
    <rect x="54" y="42" height="20" width="0">
      <animate attributeName="width" dur="${totalDur}s" repeatCount="indefinite"
        keyTimes="0;${frac(t.nameStart)};${frac(t.nameEnd)};1"
        values="0;0;${nameWidth};${nameWidth}"/>
    </rect>
  </clipPath>
  <g clip-path="url(#${clipId})">
    <text x="54" y="55" font-family="${FONT}" font-size="13" font-weight="600" fill="${colors.name}">${esc(name)}</text>
  </g>

  <g opacity="0">
    <animate attributeName="opacity" dur="${totalDur}s" repeatCount="indefinite"
      keyTimes="0;${frac(t.nameEnd)};${frac(t.lineStarts[0] ?? t.nameEnd)};1" values="0;1;1;0"/>
    <rect x="${54 + nameWidth}" y="43" width="7" height="14" fill="${colors.cursor}">
      <animate attributeName="opacity" dur="0.9s" repeatCount="indefinite" values="1;1;0;0"
        keyTimes="0;0.4;0.5;1"/>
    </rect>
  </g>

  ${descLinesSvg}

  <g opacity="0">
    <animate attributeName="opacity" dur="${totalDur}s" repeatCount="indefinite"
      keyTimes="0;${frac(t.metaStart)};${frac(t.metaEnd)};${vT2};1"
      values="0;0;1;1;0"/>

    ${linkSvg}

    ${lang ? `<circle cx="42" cy="150" r="4" fill="${lang.color || colors.muted}"/>
    <text x="52" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">${esc(lang.name)}</text>` : ""}

    <text x="${lang ? 150 : 38}" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">★ ${fmtCount(repo.stargazerCount)}</text>
    <text x="${lang ? 200 : 88}" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">⑂ ${fmtCount(repo.forkCount)}</text>

    <text x="38" y="174" font-family="${FONT}" font-size="10" fill="${colors.muted}">${index + 1}/${total} pinned</text>
  </g>

  <g opacity="0">
    <animate attributeName="opacity" dur="${totalDur}s" repeatCount="indefinite"
      keyTimes="0;${frac(t.metaStart)};${vT2};1" values="0;1;1;0"/>
    <rect x="${38 + lastLineWidth}" y="${lastLineY - 11}" width="6" height="13" fill="${colors.cursor}">
      <animate attributeName="opacity" dur="0.9s" repeatCount="indefinite" values="1;1;0;0"
        keyTimes="0;0.4;0.5;1"/>
    </rect>
  </g>
</g>`;
}

function buildSvg(repos, colors) {
  const total = repos.length;
  const prepared = repos.map((repo, i) => prepareCard(repo, i, total));

  let acc = 0;
  const absStarts = prepared.map((c) => {
    const start = acc;
    acc += c.dCard;
    return start;
  });
  const totalDur = acc;

  const cards = prepared
    .map((c, i) => buildCard(c, absStarts[i], totalDur, colors))
    .join("\n");

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${colors.bg}"/>
${cards}
</svg>`;
}

async function main() {
  const colors = PALETTES[THEME] || PALETTES.dark;
  console.log(`Fetching pinned repos for ${USERNAME}...`);
  const nodes = await fetchPinned();
  const repos = nodes.filter(Boolean).slice(0, MAX_REPOS);
  if (repos.length === 0) {
    throw new Error("No pinned repositories found for this user.");
  }
  const svg = buildSvg(repos, colors);
  const outPath = path.resolve(OUTPUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
