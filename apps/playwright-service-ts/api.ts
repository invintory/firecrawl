import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
  BrowserContextOptions,
} from "patchright";
import dotenv from "dotenv";
import UserAgent from "user-agents";
import { getError } from "./helpers/get_error";
import { getResponseFromCache, setResponseInCache } from "./requestCache.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const AD_SERVING_DOMAINS = [
  "doubleclick.net",
  "adservice.google.com",
  "googlesyndication.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adsystem.com",
  "adservice.com",
  "adnxs.com",
  "ads-twitter.com",
  "facebook.net",
  "fbcdn.net",
  "amazon-adsystem.com",
  "wootric.com",
  "klaviyo.com",
  "posthog.com",
  "getkoala.com",
  "survicate.com",
  "datadoghq.com",
  "taboola.com",
  "hotjar.io",
  "facebook.com",
  "pingdom.net",
  "flaviar.com",
];

const BLOCKED_MEDIA_TYPES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "mp3",
  "mp4",
  "avi",
  "flac",
  "ogg",
  "wav",
  "webm",
  "wasm",
  "woff",
  "woff2",
  "css",
  "ttf",
]);

const ELIGIBLE_FOR_CACHE = ["js", "css", "json"];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
}

const createBrowserWithContext = async (): Promise<BrowserContext> => {
  if (!PROXY_SERVER || !PROXY_USERNAME || !PROXY_PASSWORD) {
    throw new Error("Proxy server, username, and password are required");
  }

  const browser = await chromium.launchPersistentContext(
    `/tmp/playwright-${Math.random().toString(36).substring(2, 15)}`,
    {
      viewport: null,
      headless: false,
      channel: "chrome",
      proxy: {
        server: PROXY_SERVER,
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD,
      },
    }
  );

  // Intercept all requests to avoid loading ads, media, and JS payloads from other domains
  await browser.route(
    "**/*",
    async (route: Route, request: PlaywrightRequest) => {
      const requestUrl = new URL(request.url());
      const hostname = requestUrl.hostname;

      if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
        console.log(`Blocking ad request: ${hostname}`);
        return route.abort("aborted");
      }

      if (
        BLOCKED_MEDIA_TYPES.has(
          requestUrl.pathname.split(".")?.pop()?.toLowerCase() || ""
        )
      ) {
        console.log(`Blocking media request: ${request.url()}`);
        return route.abort("aborted");
      }

      if (
        requestUrl.pathname.includes("gtag") ||
        requestUrl.pathname.includes("gtm.js")
      ) {
        console.log(`Blocking gtag request: ${request.url()}`);
        return route.abort("aborted");
      }

      if (requestUrl.pathname.startsWith("/_next/image")) {
        console.log(`Blocking image request: ${request.url()}`);
        return route.abort("aborted");
      }

      // Get the extension of the request
      const contentType = requestUrl.pathname.split(".")?.pop()?.toLowerCase();

      if (
        eligibleForCache(contentType) &&
        process.env.REDIS_CACHE_ENABLED === "true"
      ) {
        const response = await getResponseFromCache(request.url());
        if (response) {
          console.log(`Cache hit for ${request.url()}`);
          return route.fulfill({
            status: response.status,
            headers: {
              ...response.headers,
              "x-cache-fc": "hit",
            },
            body: response.body,
          });
        }
      }
      return route.continue();
    }
  );

  return browser;
};

const eligibleForCache = (contentType?: string): boolean => {
  return ELIGIBLE_FOR_CACHE.some((type) => contentType?.includes(type));
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: "load" | "networkidle",
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`
  );

  // Collect all requests and bytes used
  const networkData: { url: string; bytes: number }[] = [];

  page.on("response", async (response) => {
    const url = response.url();

    // Response body is not available for some requests
    if (response.status() === 200 && response.ok()) {
      try {
        await response.finished();

        const body = await response.body();

        const allResponseData = await response.allHeaders();

        if (allResponseData["x-cache-fc"] === "hit") {
          return;
        }

        networkData.push({ url, bytes: body.byteLength });

        const responseUrl = new URL(url);

        const contentType = responseUrl.pathname
          .split(".")
          ?.pop()
          ?.toLowerCase();

        if (
          eligibleForCache(contentType) &&
          process.env.REDIS_CACHE_ENABLED === "true"
        ) {
          // Save in Redis Cache
          await setResponseInCache(url, {
            status: response.status(),
            headers: allResponseData,
            body,
          });
        }

        console.log(`${url} - ${Math.round(body.byteLength / 1000)} KB`);
      } catch (error) {
        console.log(`Error getting body for ${url}: ${error}`);
      }
    }
  });

  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error("Required selector not found");
    }
  }

  let headers = null,
    content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      (x) => x[0].toLowerCase() === "content-type"
    )?.[1];
    if (
      ct &&
      (ct[1].includes("application/json") || ct[1].includes("text/plain"))
    ) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  let totalBytes = 0;
  for (const item of networkData) {
    totalBytes += item.bytes;
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
    bytes: totalBytes,
    totalKB: Math.round(totalBytes / 1000),
    networkData,
  };
};

app.post("/scrape", async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : "None"}`);
  console.log(`Check Selector: ${check_selector ? check_selector : "None"}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!PROXY_SERVER) {
    console.warn(
      "⚠️ WARNING: No proxy server provided. Your IP address may be blocked."
    );
  }

  const browser = await createBrowserWithContext();
  const page = await browser.newPage();

  try {
    // Set headers if provided
    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }

    let result: Awaited<ReturnType<typeof scrapePage>>;
    try {
      // Strategy 1: Normal
      console.log("Attempting strategy 1: Normal load");
      result = await scrapePage(
        page,
        url,
        "load",
        wait_after_load,
        timeout,
        check_selector
      );
    } catch (error) {
      console.log(
        "Strategy 1 failed, attempting strategy 2: Wait until networkidle"
      );
      try {
        // Strategy 2: Wait until networkidle
        result = await scrapePage(
          page,
          url,
          "networkidle",
          wait_after_load,
          timeout,
          check_selector
        );
      } catch (finalError) {
        await page.close();
        return res
          .status(500)
          .json({ error: "An error occurred while fetching the page." });
      }
    }

    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      console.log(
        `✅ Scrape successful! ${result.totalKB ? `KB: ${result.totalKB}` : ""}`
      );
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}. ${
          result.totalKB ? `KB: ${result.totalKB}` : ""
        }`
      );
    }

    await page.close();

    console.log(
      JSON.stringify(
        result.networkData.sort((a, b) => b.bytes - a.bytes),
        null,
        2
      )
    );

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      bytes: result.bytes,
      totalKB: result.totalKB,
      networkData: result.networkData,
      contentType: result.contentType,
      ...(pageError && { pageError }),
    });
  } finally {
    // Ensure context is always closed
    await browser.close();
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

process.on("SIGINT", () => {
  process.exit(0);
});
