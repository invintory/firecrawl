import { url } from "../types";
import { BLOCKLISTED_URL_MESSAGE } from "../../../lib/strings";

describe("URL Schema Validation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("should prepend http:// to URLs without a protocol", () => {
    const result = url.parse("example.com");
    expect(result).toBe("http://example.com");
  });

  it("should allow valid URLs with http or https", () => {
    expect(() => url.parse("http://example.com")).not.toThrow();
    expect(() => url.parse("https://example.com")).not.toThrow();
  });

  it("should allow valid URLs with http or https", () => {
    expect(() => url.parse("example.com")).not.toThrow();
  });

  it("should reject URLs with unsupported protocols", () => {
    expect(() => url.parse("ftp://example.com")).toThrow("Invalid URL");
  });

  it("should reject URLs without a valid top-level domain", () => {
    expect(() => url.parse("http://example")).toThrow(
      "URL must have a valid top-level domain or be a valid path",
    );
  });

  it("should reject blocked URLs", () => {
    expect(() => url.parse("https://facebook.com")).toThrow(
      BLOCKLISTED_URL_MESSAGE,
    );
  });

  it("should handle URLs with subdomains correctly", () => {
    expect(() => url.parse("http://sub.example.com")).not.toThrow();
    expect(() => url.parse("https://blog.example.com")).not.toThrow();
  });

  it("should handle URLs with paths correctly", () => {
    expect(() => url.parse("http://example.com/path")).not.toThrow();
    expect(() => url.parse("https://example.com/another/path")).not.toThrow();
  });

  it("should handle URLs with subdomains that are blocked", () => {
    expect(() => url.parse("https://sub.facebook.com")).toThrow(
      BLOCKLISTED_URL_MESSAGE,
    );
  });

  it("should handle URLs with paths that are blocked", () => {
    expect(() => url.parse("http://facebook.com/path")).toThrow(
      BLOCKLISTED_URL_MESSAGE,
    );
    expect(() => url.parse("https://facebook.com/another/path")).toThrow(
      BLOCKLISTED_URL_MESSAGE,
    );
  });

  it("should reject malformed URLs starting with 'http://http'", () => {
    expect(() => url.parse("http://http://example.com")).toThrow(
      "Invalid URL. Invalid protocol.",
    );
  });

  it("should reject malformed URLs containing multiple 'http://'", () => {
    expect(() =>
      url.parse("http://example.com/http://example.com"),
    ).not.toThrow();
  });

  it("should reject malformed URLs containing multiple 'http://'", () => {
    expect(() => url.parse("http://ex ample.com/")).toThrow("Invalid URL");
  });

  it("should accept URLs with international domain names", () => {
    expect(() => url.parse("http://xn--1lqv92a901a.xn--ses554g/")).not.toThrow();
  });

});
