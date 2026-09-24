import type { Evidence } from "./schemas";

export type SearchHit = Evidence;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      host.includes(".") &&
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      !host.endsWith(".local") &&
      !/^\d+(?:\.\d+){3}$/.test(host) &&
      !host.includes(":")
    );
  } catch {
    return false;
  }
}

export async function searchPublicWeb(
  query: string,
  fetcher: typeof fetch = fetch
): Promise<SearchHit[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query.slice(0, 180))}`;
  const response = await fetcher(url, {
    headers: { "user-agent": "Mozilla/5.0 ROOT Research/1.0" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok)
    throw new Error(`Search failed with HTTP ${response.status}`);
  const html = (await response.text()).slice(0, 120000);
  const items = [
    ...html.matchAll(
      /<a\s+[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\s+[^>]*class=['"]result-link['"]|$)/gi
    )
  ].slice(0, 5);
  const retrievedAt = new Date().toISOString();
  return items.flatMap(([, encodedLink, title, following]) => {
    let sourceUrl: string;
    try {
      const redirect = new URL(
        decodeXml(encodedLink),
        "https://duckduckgo.com"
      );
      sourceUrl = redirect.searchParams.get("uddg") ?? "";
    } catch {
      return [];
    }
    if (!isPublicWebUrl(sourceUrl)) return [];
    const snippet = following.match(
      /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i
    )?.[1];
    return [
      {
        sourceUrl,
        title: decodeXml(title ?? "Untitled").slice(0, 300),
        observation: decodeXml(
          snippet ?? "Search result without snippet"
        ).slice(0, 1600),
        retrievedAt
      }
    ];
  });
}

export async function readPublicPage(
  sourceUrl: string,
  fetcher: typeof fetch = fetch
): Promise<Evidence | null> {
  if (!isPublicWebUrl(sourceUrl)) return null;
  const response = await fetcher(sourceUrl, {
    headers: { "user-agent": "Mozilla/5.0 ROOT Research/1.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || !isPublicWebUrl(response.url)) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain")
  ) {
    return null;
  }
  const html = (await response.text()).slice(0, 30000);
  const title = decodeXml(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Public page"
  );
  const observation = decodeXml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
  ).slice(0, 1600);
  return {
    sourceUrl: response.url,
    title: title.slice(0, 300),
    observation,
    retrievedAt: new Date().toISOString()
  };
}
