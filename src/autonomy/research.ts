import { evidenceSchema, type Evidence } from "./schemas";

export type SearchHit = Evidence;

export async function searchViaBridge(
  query: string,
  baseURL?: string,
  token?: string,
  fetcher: typeof fetch = fetch
): Promise<SearchHit[]> {
  if (baseURL && token) {
    try {
      const response = await fetcher(
        `${baseURL.replace(/\/$/, "")}/research/search?q=${encodeURIComponent(query.slice(0, 160))}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20000)
        }
      );
      if (response.ok)
        return evidenceSchema
          .array()
          .max(5)
          .parse(await response.json());
    } catch {
      // The Worker can still try direct public search when the bridge is down.
    }
  }
  return searchPublicWeb(query, fetcher);
}

export async function readViaBridge(
  sourceUrl: string,
  baseURL?: string,
  token?: string,
  fetcher: typeof fetch = fetch
): Promise<Evidence | null> {
  if (!isPublicWebUrl(sourceUrl)) return null;
  if (baseURL && token) {
    try {
      const response = await fetcher(
        `${baseURL.replace(/\/$/, "")}/research/read?url=${encodeURIComponent(sourceUrl)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(12000)
        }
      );
      if (response.ok)
        return evidenceSchema.nullable().parse(await response.json());
    } catch {
      // Fall back to a direct Worker fetch.
    }
  }
  return readPublicPage(sourceUrl, fetcher);
}

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
  const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(query.slice(0, 180))}`;
  try {
    const brave = await fetcher(braveUrl, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (brave.ok) {
      const html = (await brave.text()).slice(0, 120000);
      const seen = new Set<string>();
      const retrievedAt = new Date().toISOString();
      const hits = [
        ...html.matchAll(
          /<a[^>]+href=["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        )
      ]
        .flatMap(([, rawUrl, rawTitle]) => {
          const sourceUrl = decodeXml(rawUrl);
          if (!isPublicWebUrl(sourceUrl) || seen.has(sourceUrl)) return [];
          seen.add(sourceUrl);
          const title = decodeXml(rawTitle).slice(0, 300);
          if (!title) return [];
          return [
            {
              sourceUrl,
              title,
              observation: `Public search result link observed for: ${query.slice(0, 120)}`,
              retrievedAt
            }
          ];
        })
        .slice(0, 5);
      if (hits.length > 0) return hits;
    }
  } catch {
    // A search provider may block Worker traffic; try the next public source.
  }
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
  const html = (await response.text()).slice(0, 150000);
  const url = new URL(response.url);
  if (
    ["freelancermap.de", "www.freelancermap.de"].includes(url.hostname) &&
    url.pathname.startsWith("/projekt/")
  ) {
    const embedded = html.match(
      /<script\b(?=[^>]*data-component-name=["']ProjectShow["'])[^>]*>([\s\S]*?)<\/script>/i
    )?.[1];
    if (embedded) {
      try {
        const raw: unknown = JSON.parse(embedded);
        const project =
          raw && typeof raw === "object" && "project" in raw
            ? raw.project
            : null;
        if (project && typeof project === "object") {
          const fields = project as Record<string, unknown>;
          const title =
            typeof fields.title === "string" ? fields.title : "Public project";
          const description =
            typeof fields.description === "string"
              ? decodeXml(fields.description).slice(0, 1200)
              : "";
          const created =
            typeof fields.created === "string" ? fields.created : "unknown";
          const budget = fields.budget;
          let budgetText = "Budget: not stated";
          if (budget && typeof budget === "object") {
            const amount = (budget as Record<string, unknown>).amountInCents;
            const currency = (budget as Record<string, unknown>).currency;
            const code =
              currency && typeof currency === "object"
                ? (currency as Record<string, unknown>).code
                : null;
            if (typeof amount === "number" && typeof code === "string")
              budgetText = `Budget: ${amount / 100} ${code}`;
          }
          return {
            sourceUrl: response.url,
            title: decodeXml(title).slice(0, 300),
            observation:
              `Project date: ${created}. ${budgetText}. Description: ${description}`.slice(
                0,
                1600
              ),
            retrievedAt: new Date().toISOString()
          };
        }
      } catch {
        // Fall back to generic public-page text when embedded data changes.
      }
    }
  }
  const title = decodeXml(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Public page"
  );
  const observation = decodeXml(
    html
      .slice(0, 30000)
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
