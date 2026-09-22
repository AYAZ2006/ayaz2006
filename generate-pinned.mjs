#!/usr/bin/env node
/**
 * Generates an animated "pinned repos" terminal-style SVG carousel using
 * a GitHub user's REAL pinned repositories (via GraphQL).
 *
 * Cards crossfade one after another; each repo name types out character
 * by character, then the description fades in, then a blinking cursor
 * sits at the end until the next card takes over.
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
const PER_CARD = 5.5; // seconds each card stays on screen (fade in + hold + fade out)
const TYPE_DUR = 1.1; // seconds for the name to finish "typing"
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

function buildCard(repo, index, total, colors) {
  const slotStart = index / total;
  const slotEnd = (index + 1) / total;
  const fadeIn = 0.06; // fraction of PER_CARD spent fading in
  const fadeOut = 0.06;
  const typeFrac = TYPE_DUR / PER_CARD;

  // keyTimes for this card's opacity: hidden -> fade in -> hold -> fade out -> hidden
  const t0 = slotStart;
  const t1 = fmt(slotStart + fadeIn / total);
  const t2 = fmt(slotEnd - fadeOut / total);
  const t3 = slotEnd;

  const name = truncate(repo.name, 28);
  const descLines = wrapText(
    repo.description || "No description provided",
    DESC_MAX_CHARS,
    DESC_MAX_LINES
  );
  const lang = repo.primaryLanguage;
  const nameWidth = fmt(name.length * CHAR_W);
  const homepage = repo.homepageUrl && repo.homepageUrl.trim();

  const typeStart = fmt(slotStart + 0.01);
  const typeEnd = fmt(slotStart + typeFrac);
  const descFadeStart = fmt(typeEnd);
  const descFadeEnd = fmt(typeEnd + 0.03);

  const cardId = `card${index}`;
  const clipId = `typeclip${index}`;

  const descLinesSvg = descLines
    .map(
      (line, i) =>
        `<text x="38" y="${78 + i * 15}" font-family="${FONT}" font-size="11.5" fill="${colors.desc}">${esc(line)}</text>`
    )
    .join("\n    ");

  const linkSvg = homepage
    ? `<a href="${escAttr(homepage)}" xlink:href="${escAttr(homepage)}" target="_blank">
      <text x="38" y="128" font-family="${FONT}" font-size="10.5" fill="${colors.prompt}" text-decoration="underline">🔗 ${esc(displayUrl(homepage, 56))}</text>
    </a>`
    : "";

  return `
<g id="${cardId}" opacity="0">
  <animate attributeName="opacity" dur="${total * PER_CARD}s" repeatCount="indefinite"
    keyTimes="0;${t0};${t1};${t2};${t3};1"
    values="0;0;1;1;0;0"/>

  <rect x="20" y="24" width="${WIDTH - 40}" height="160" rx="8" ry="8"
    fill="${colors.cardBg}" stroke="${colors.border}" stroke-width="1"/>

  <text x="38" y="55" font-family="${FONT}" font-size="13" fill="${colors.prompt}">$</text>

  <clipPath id="${clipId}">
    <rect x="54" y="42" height="20" width="0">
      <animate attributeName="width" dur="${total * PER_CARD}s" repeatCount="indefinite"
        keyTimes="0;${typeStart};${typeEnd};1"
        values="0;0;${nameWidth};${nameWidth}"/>
    </rect>
  </clipPath>
  <g clip-path="url(#${clipId})">
    <text x="54" y="55" font-family="${FONT}" font-size="13" font-weight="600" fill="${colors.name}">${esc(name)}</text>
  </g>

  <g opacity="0">
    <animate attributeName="opacity" dur="${total * PER_CARD}s" repeatCount="indefinite"
      keyTimes="0;${typeEnd};${t2};1" values="0;1;1;0"/>
    <rect x="${54 + nameWidth}" y="43" width="7" height="14" fill="${colors.cursor}">
      <animate attributeName="opacity" dur="0.9s" repeatCount="indefinite" values="1;1;0;0"
        keyTimes="0;0.4;0.5;1"/>
    </rect>
  </g>

  <g opacity="0">
    <animate attributeName="opacity" dur="${total * PER_CARD}s" repeatCount="indefinite"
      keyTimes="0;${descFadeStart};${descFadeEnd};${t2};1"
      values="0;0;1;1;0"/>
    ${descLinesSvg}

    ${linkSvg}

    ${lang ? `<circle cx="42" cy="150" r="4" fill="${lang.color || colors.muted}"/>
    <text x="52" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">${esc(lang.name)}</text>` : ""}

    <text x="${lang ? 150 : 38}" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">★ ${fmtCount(repo.stargazerCount)}</text>
    <text x="${lang ? 200 : 88}" y="154" font-family="${FONT}" font-size="11" fill="${colors.desc}">⑂ ${fmtCount(repo.forkCount)}</text>

    <text x="38" y="174" font-family="${FONT}" font-size="10" fill="${colors.muted}">${index + 1}/${total} pinned</text>
  </g>
</g>`;
}

function buildSvg(repos, colors) {
  const total = repos.length;
  const cards = repos.map((repo, i) => buildCard(repo, i, total, colors)).join("\n");

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
