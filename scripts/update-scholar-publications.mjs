import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scholarUserId = "l3WMApQAAAAJ";
const scholarProfileUrl = `https://scholar.google.com/citations?hl=en&user=${scholarUserId}`;
const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/data/publications.json",
);

const maxPublications = Number.parseInt(process.env.SCHOLAR_PUBLICATION_LIMIT || "8", 10);

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteScholarUrl(href) {
  if (!href) return scholarProfileUrl;
  if (href.startsWith("http")) return href;
  return `https://scholar.google.com${href.replace(/&amp;/g, "&")}`;
}

function readAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}=(["'])(.*?)\\1`));
  return match?.[2] || "";
}

function parsePublications(html) {
  const rows = html.match(/<tr\b[^>]*class=(["'])gsc_a_tr\1[^>]*>[\s\S]*?<\/tr>/g) || [];

  return rows.map((row) => {
    const titleMatch = row.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
    const metadata = [...row.matchAll(/<div\b[^>]*class=(["'])gs_gray\1[^>]*>([\s\S]*?)<\/div>/g)].map((match) => decodeHtml(match[2].replace(/<[^>]*>/g, "")));
    const yearMatch = row.match(/<span\b[^>]*class=(["'])gsc_a_h gsc_a_hc gs_ibl\1[^>]*>(\d{4})<\/span>/);

    if (!titleMatch || readAttribute(titleMatch[1], "class") !== "gsc_a_at") return null;

    return {
      year: yearMatch?.[2] || "",
      title: decodeHtml(titleMatch[2].replace(/<[^>]*>/g, "")),
      journal: metadata[1] || "Google Scholar",
      href: absoluteScholarUrl(readAttribute(titleMatch[1], "href")),
    };
  }).filter(Boolean);
}

const browserHeaders = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchScholarPublications() {
  const urls = [
    `${scholarProfileUrl}&cstart=0&pagesize=20&sortby=pubdate`,
    `${scholarProfileUrl}&cstart=0&pagesize=100&sortby=pubdate`,
  ];

  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch(url, { headers: browserHeaders });

      if (!response.ok) {
        console.warn(`Google Scholar returned ${response.status} ${response.statusText} (attempt ${attempt}).`);
        await sleep(5000);
        continue;
      }

      const html = await response.text();
      if (/gs_captcha|unusual traffic|sorry\/index/i.test(html)) {
        throw new Error("Google Scholar served a CAPTCHA / bot-check page to this runner.");
      }

      const publications = parsePublications(html);
      if (publications.length > 0) return publications.slice(0, maxPublications);
      break;
    }
  }

  throw new Error("Google Scholar did not return any publications (likely blocked from GitHub Actions).");
}

// OpenAlex fallback: free scholarly API that does not block CI runners.
// Author IDs are the IISER Mohali profiles for Ali P. Yunus / Yunus Ali Pulpadan.
const openAlexAuthorIds = (process.env.OPENALEX_AUTHOR_IDS || "A5110677826|A5043027894").trim();

function cleanTitle(value) {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchOpenAlexPublications() {
  const params = new URLSearchParams({
    filter: `author.id:${openAlexAuthorIds},type:article|review|book-chapter|preprint`,
    sort: "publication_date:desc",
    "per-page": String(Math.max(maxPublications * 2, 20)),
    select: "id,doi,title,publication_year,primary_location,biblio",
  });
  if (process.env.OPENALEX_MAILTO) params.set("mailto", process.env.OPENALEX_MAILTO);

  const response = await fetch(`https://api.openalex.org/works?${params}`);
  if (!response.ok) throw new Error(`OpenAlex returned ${response.status} ${response.statusText}`);

  const { results = [] } = await response.json();
  const seen = new Set();

  return results
    .filter((work) => work.title)
    .filter((work) => {
      const key = cleanTitle(work.title).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxPublications)
    .map((work) => {
      const source = work.primary_location?.source?.display_name;
      const { volume, issue, first_page: first, last_page: last } = work.biblio || {};
      const parts = [source || (work.doi?.includes("egusphere") ? "EGUsphere" : "Preprint")];
      if (volume) parts[0] += ` ${volume}${issue ? ` (${issue})` : ""}`;
      if (first) parts.push(last ? `${first}-${last}` : first);
      parts.push(String(work.publication_year || ""));

      return {
        year: String(work.publication_year || ""),
        title: cleanTitle(work.title),
        journal: parts.filter(Boolean).join(", "),
        href: work.doi || work.primary_location?.landing_page_url || work.id,
      };
    });
}

async function main() {
  const previous = await readFile(outputPath, "utf8").catch(() => "[]");

  let publications = [];
  try {
    publications = await fetchScholarPublications();
    console.log("Fetched publications from Google Scholar.");
  } catch (error) {
    console.warn(`::warning::${error.message} Falling back to OpenAlex.`);
    try {
      publications = await fetchOpenAlexPublications();
      console.log("Fetched publications from OpenAlex.");
    } catch (fallbackError) {
      console.warn(`::warning::${fallbackError.message}`);
    }
  }

  if (publications.length === 0) {
    console.warn("::warning::No publication source was reachable; keeping the existing publications.json.");
    return;
  }

  const next = `${JSON.stringify(publications, null, 2)}\n`;

  if (previous === next) {
    console.log("Recent publications are already up to date.");
    return;
  }

  await writeFile(outputPath, next);
  console.log(`Updated ${publications.length} recent publications.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
