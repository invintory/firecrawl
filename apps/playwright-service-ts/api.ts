import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import {
  chromium,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from "patchright";
import dotenv from "dotenv";
import { getError } from "./helpers/get_error";
import { getResponseFromCache, setResponseInCache } from "./requestCache";
import { promises as fs } from "fs";
import logger from "./helpers/logger";

dotenv.config();

interface BrowserPoolItem {
  browser: BrowserContext;
  tempDir: string;
}

class BrowserPool {
  private availableBrowsers: BrowserPoolItem[] = [];
  private waitingQueue: Array<{
    resolve: (browser: BrowserPoolItem) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly poolSize = 4;
  private isInitialized = false;

  async initialize() {
    if (this.isInitialized) return;

    logger.info({
      message: "Initializing browser pool",
      poolSize: this.poolSize,
    });

    for (let i = 0; i < this.poolSize; i++) {
      try {
        const { browser, tempDir } = await createBrowserWithContext();
        this.availableBrowsers.push({ browser, tempDir });
        logger.debug({
          message: `Browser ${i + 1} initialized`,
        });
      } catch (error) {
        logger.error({
          message: `Failed to initialize browser ${i + 1}`,
          error,
        });
        throw error;
      }
    }

    this.isInitialized = true;
    logger.info({
      message: "Browser pool initialized successfully",
      availableBrowsers: this.availableBrowsers.length,
    });
  }

  async getBrowser(timeoutMs: number = 5000): Promise<BrowserPoolItem> {
    return new Promise((resolve, reject) => {
      // Set a timeout to prevent hanging requests
      const timeout = setTimeout(() => {
        // Remove from waiting queue if still there
        const index = this.waitingQueue.findIndex(
          (item) => item.resolve === resolve
        );
        if (index >= 0) {
          this.waitingQueue.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for browser (${timeoutMs}ms)`));
      }, timeoutMs);

      const resolveWithCleanup = (browser: BrowserPoolItem) => {
        clearTimeout(timeout);
        resolve(browser);
      };

      const rejectWithCleanup = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      if (this.availableBrowsers.length > 0) {
        const browser = this.availableBrowsers.shift()!;
        logger.debug({
          message: "Browser acquired from pool",
          availableBrowsers: this.availableBrowsers.length,
          waitingQueue: this.waitingQueue.length,
        });
        resolveWithCleanup(browser);
      } else {
        logger.debug({
          message: "No browsers available, adding to waiting queue",
          waitingQueue: this.waitingQueue.length + 1,
        });
        this.waitingQueue.push({
          resolve: resolveWithCleanup,
          reject: rejectWithCleanup,
        });
      }
    });
  }

  async releaseBrowser(item: BrowserPoolItem) {
    try {
      logger.debug({
        message: "Releasing browser",
        availableBrowsers: this.availableBrowsers.length,
        waitingQueue: this.waitingQueue.length,
      });

      // Close the browser and clean up
      await item.browser.close();
      await cleanupTempDirectory(item.tempDir);

      // Create a new browser
      const { browser, tempDir } = await createBrowserWithContext();
      const newBrowserItem = { browser, tempDir };

      // Check if anyone is waiting
      if (this.waitingQueue.length > 0) {
        const waiter = this.waitingQueue.shift()!;
        logger.debug({
          message: "Browser released to waiting request",
          waitingQueue: this.waitingQueue.length,
        });
        waiter.resolve(newBrowserItem);
      } else {
        this.availableBrowsers.push(newBrowserItem);
        logger.debug({
          message: "Browser returned to pool",
          availableBrowsers: this.availableBrowsers.length,
        });
      }
    } catch (error) {
      logger.error({
        message: "Error releasing browser",
        error,
      });

      // If anyone is waiting, reject them
      if (this.waitingQueue.length > 0) {
        const waiter = this.waitingQueue.shift()!;
        waiter.reject(error as Error);
      }
    }
  }

  async cleanup() {
    logger.info({
      message: "Cleaning up browser pool",
      availableBrowsers: this.availableBrowsers.length,
    });

    // Close all available browsers
    for (const item of this.availableBrowsers) {
      try {
        await item.browser.close();
        await cleanupTempDirectory(item.tempDir);
      } catch (error) {
        logger.error({
          message: "Error cleaning up browser",
          error,
        });
      }
    }

    this.availableBrowsers = [];

    // Reject all waiting requests
    for (const waiter of this.waitingQueue) {
      waiter.reject(new Error("Browser pool is shutting down"));
    }

    this.waitingQueue = [];
    this.isInitialized = false;
  }

  // Getter methods for health check
  getAvailableBrowsersCount(): number {
    return this.availableBrowsers.length;
  }

  getWaitingQueueCount(): number {
    return this.waitingQueue.length;
  }

  getIsInitialized(): boolean {
    return this.isInitialized;
  }
}

const browserPool = new BrowserPool();

const app = express();
const port = process.env.PORT || 3004;

app.use(bodyParser.json());

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    port,
    browserPool: {
      availableBrowsers: browserPool.getAvailableBrowsersCount(),
      waitingQueue: browserPool.getWaitingQueueCount(),
      isInitialized: browserPool.getIsInitialized(),
    },
  });
});

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
  "optimizationguide-pa.googleapis.com",
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

// Cleanup function to remove temporary directories
const cleanupTempDirectory = async (dirPath: string): Promise<void> => {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    logger.debug(`Cleaned up temporary directory: ${dirPath}`);
  } catch (error) {
    logger.error(`Failed to clean up directory ${dirPath}:`, error);
  }
};

const createBrowserWithContext = async (): Promise<{
  browser: BrowserContext;
  tempDir: string;
}> => {
  if (!PROXY_SERVER || !PROXY_USERNAME || !PROXY_PASSWORD) {
    throw new Error("Proxy server, username, and password are required");
  }

  const tempDir = `/tmp/playwright-${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const browser = await chromium.launchPersistentContext(tempDir, {
    viewport: null,
    headless: false,
    channel: "chrome",
    proxy: {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    },
    args: [
      "--disable-features=TranslateUI,OptimizationHints,OptimizationGuideModelDownloading",
    ],
  });

  await browser.route(
    "**/optimizationguide-pa.googleapis.com/*",
    async (route: Route, request: PlaywrightRequest) => {
      logger.debug({
        message: "Blocking optimizationguide request",
        url: request.url(),
      });
      return route.abort("aborted");
    }
  );

  // Intercept all requests to avoid loading ads, media, and JS payloads from other domains
  await browser.route(
    "**/*",
    async (route: Route, request: PlaywrightRequest) => {
      const requestUrl = new URL(request.url());
      const hostname = requestUrl.hostname;

      if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
        logger.debug({
          message: "Blocking ad request",
          url: request.url(),
        });
        return route.abort("aborted");
      }

      if (
        BLOCKED_MEDIA_TYPES.has(
          requestUrl.pathname.split(".")?.pop()?.toLowerCase() || ""
        )
      ) {
        logger.debug({
          message: "Blocking media request",
          url: request.url(),
        });
        return route.abort("aborted");
      }

      if (
        requestUrl.pathname.includes("gtag") ||
        requestUrl.pathname.includes("gtm.js")
      ) {
        logger.debug({
          message: "Blocking gtag request",
          url: request.url(),
        });
        return route.abort("aborted");
      }

      if (requestUrl.pathname.startsWith("/_next/image")) {
        logger.debug({
          message: "Blocking image request",
          url: request.url(),
        });
        return route.abort("aborted");
      }

      // Get the extension of the request
      const contentType = requestUrl.pathname.split(".")?.pop()?.toLowerCase();

      const isGoogleFont =
        requestUrl.hostname.includes("fonts.gstatic.com") ||
        requestUrl.hostname.includes("fonts.googleapis.com");

      if (
        (eligibleForCache(contentType) || isGoogleFont) &&
        process.env.REDIS_CACHE_ENABLED === "true"
      ) {
        const response = await getResponseFromCache(request.url());
        if (response) {
          logger.debug({
            message: "Cache hit",
            url: request.url(),
          });
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
      return route.continue({
        headers: {
          ...request.headers(),
          // "Accept-Encoding": "gzip, deflate, br, zstd",
        },
      });
    }
  );

  return { browser, tempDir };
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
  logger.info({
    message: "Navigating to page",
    url,
    waitUntil,
    timeout,
  });

  // Collect all requests and bytes used
  const networkData: {
    url: string;
    bytes: number;
    contentEncoding: string | undefined;
    contentLength: string | undefined;
  }[] = [];

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

        const contentEncoding = allResponseData["content-encoding"];

        const contentLength = allResponseData["content-length"];

        networkData.push({
          url,
          bytes: body.byteLength,
          contentEncoding,
          contentLength,
        });

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

        logger.debug({
          message: "Response received",
          url,
          bytes: Math.round(body.byteLength / 1000),
        });
      } catch (error) {
        logger.error({
          message: "Error getting body for url",
          url,
          error,
        });
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

  logger.info({
    message: "Scrape Request",
    url,
    wait_after_load,
    timeout,
    headers,
    check_selector,
  });

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!PROXY_SERVER) {
    logger.warn({
      message:
        "⚠️ WARNING: No proxy server provided. Your IP address may be blocked.",
    });
  }

  // Get browser from pool
  let browserItem: BrowserPoolItem;
  try {
    browserItem = await browserPool.getBrowser(5000);
  } catch (error) {
    logger.error({
      message: "Failed to get browser from pool",
      error,
    });
    return res.status(500).json({ error: "Failed to get browser from pool" });
  }

  const { browser } = browserItem;
  const page = await browser.newPage();

  try {
    // Set headers if provided
    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }

    let result: Awaited<ReturnType<typeof scrapePage>>;
    try {
      // Strategy 1: Normal
      logger.info({
        message: "Attempting strategy 1: Normal load",
      });
      result = await scrapePage(
        page,
        url,
        "load",
        wait_after_load,
        timeout,
        check_selector
      );
    } catch (error) {
      logger.info({
        message:
          "Strategy 1 failed, attempting strategy 2: Wait until networkidle",
      });
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
        await browserPool.releaseBrowser(browserItem);
        return res
          .status(500)
          .json({ error: "An error occurred while fetching the page." });
      }
    }

    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      logger.info({
        message: "✅ Scrape successful!",
        totalKB: result.totalKB,
      });
    } else {
      logger.error({
        message: "🚨 Scrape failed",
        status: result.status,
        pageError,
        totalKB: result.totalKB,
      });
    }

    await page.close();

    logger.debug({
      message: "Network data",
      networkData: result.networkData.sort((a, b) => b.bytes - a.bytes),
    });

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
    // Release browser back to pool
    await browserPool.releaseBrowser(browserItem);
  }
});

app.listen(port, async () => {
  logger.info({
    message: `Server is running on port ${port}`,
  });

  // Initialize browser pool
  try {
    await browserPool.initialize();
  } catch (error) {
    console.log(error);
    logger.error({
      message: "Failed to initialize browser pool",
      error,
    });
    process.exit(1);
  }
});

// Graceful shutdown handler
const gracefulShutdown = async () => {
  logger.info({
    message: "Shutting down gracefully...",
  });

  // Clean up browser pool
  await browserPool.cleanup();

  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
