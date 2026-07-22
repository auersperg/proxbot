import { describe, expect, test } from "bun:test";

import { redactRaw, redactUrlMetadata } from "../../src/redaction.ts";

const REDACTED = "<redacted-by-proxbot-mcp>";

describe("redactRaw", () => {
  test("redacts standard, vendor-prefixed, camel-case, and suffix-classified credential headers", () => {
    const secrets = [
      ["Authorization", "Bearer auth-secret"],
      ["Proxy-Authorization", "Basic proxy-secret"],
      ["Cookie", "sid=cookie-secret"],
      ["Set-Cookie", "sid=response-cookie-secret"],
      ["X-Api-Key", "api-key-secret"],
      ["X-Goog-Api-Key", "google-key-secret"],
      ["X-Amz-Security-Token", "aws-token-secret"],
      ["X-Client-Secret", "oauth-client-secret"],
      ["X-Csrf-Token", "csrf-token-secret"],
      ["ServiceAccessToken", "suffix-token-secret"],
    ] as const;
    const input = [
      "POST /login HTTP/1.1",
      "Content-Type: application/json",
      "X-Request-ID: public-request-id",
      ...secrets.map(([name, value]) => `${name}: ${value}`),
      "",
      '{"visible":"ok"}',
    ].join("\r\n");

    const result = redactRaw(input, 64 * 1024);

    for (const [, secret] of secrets) expect(result.content).not.toContain(secret);
    expect(result.content).toContain("Content-Type: application/json");
    expect(result.content).toContain("X-Request-ID: public-request-id");
    expect(result.content).toContain('"visible":"ok"');
    expect(result.redactions).toBe(secrets.length);
  });

  test("redacts sensitive query, fragment, and form parameters including the first body field", () => {
    const input = [
      "POST /callback?access_token=query-access&visible=yes#id_token=fragment-id HTTP/1.1",
      "Content-Type: application/x-www-form-urlencoded",
      "",
      "password=body-password&client_secret=oauth-secret&access%5Ftoken=encoded-secret&visible=ok",
    ].join("\r\n");

    const result = redactRaw(input, 64 * 1024);

    for (const secret of [
      "query-access",
      "fragment-id",
      "body-password",
      "oauth-secret",
      "encoded-secret",
    ]) {
      expect(result.content).not.toContain(secret);
    }
    expect(result.content).toContain("visible=yes");
    expect(result.content).toContain("visible=ok");
    expect(result.redactions).toBe(5);
  });

  test("redacts JSON string and scalar credentials with snake, camel, and vendor key spellings", () => {
    const input = JSON.stringify({
      access_token: "access-secret",
      client_secret: "client-secret",
      clientSecret: "camel-secret",
      privateKey: "private-key-secret",
      seed_phrase: "seed words",
      password: 123456,
      otp: 654321,
      enabled: true,
      visible: "ok",
    });

    const result = redactRaw(input, 64 * 1024);

    for (const secret of [
      "access-secret",
      "client-secret",
      "camel-secret",
      "private-key-secret",
      "seed words",
      "123456",
      "654321",
    ]) {
      expect(result.content).not.toContain(secret);
    }
    expect(result.content).toContain('"enabled":true');
    expect(result.content).toContain('"visible":"ok"');
    expect(result.redactions).toBe(7);
  });

  test("redacts private keys, URL userinfo, JWTs, and high-confidence provider token shapes", () => {
    const credentials = [
      "user-password",
      "eyJaaaaaaaa.bbbbbbbb.cccccccc",
      "AKIAIOSFODNN7EXAMPLE",
      "github_pat_1234567890abcdefghijklmnop",
      "ghp_1234567890abcdefghijklmnop",
      "xoxb-1234567890-abcdefghijkl",
      "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    ];
    const input = [
      `https://user:${credentials[0]}@example.test/private`,
      ...credentials.slice(1),
    ].join("\n");

    const result = redactRaw(input, 64 * 1024);

    for (const credential of credentials) expect(result.content).not.toContain(credential);
    expect(result.content).toContain(`https://${REDACTED}:${REDACTED}@example.test/private`);
    expect(result.redactions).toBe(7);
  });

  test("does not redact benign names that merely contain key-like substrings", () => {
    const input = [
      "Monkey: capuchin",
      "Keyboard-Layout: qwerty",
      "",
      "monkey=capuchin&keyboard=qwerty&visible_key=sorting",
      '{"hockey":"puck","visible_key":"sorting"}',
    ].join("\r\n");

    const result = redactRaw(input, 64 * 1024);

    expect(result.content).toBe(input);
    expect(result.redactions).toBe(0);
  });

  test("redacts before applying the independent UTF-8 byte cap", () => {
    const secret = "never-return-this-secret";
    const result = redactRaw(`Authorization: Bearer ${secret}\r\n\r\n${"🛰".repeat(1_000)}`, 1_025);

    expect(result.content).not.toContain(secret);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1_025);
    expect(result.truncated).toBe(true);
    expect(result.redactions).toBe(1);
  });
});

describe("redactUrlMetadata", () => {
  test("redacts query and fragment credentials while retaining routing metadata", () => {
    const output = redactUrlMetadata(
      "/oauth/callback?code=authorization-code&client_id=public-client&access%5Ftoken=encoded-token#id_token=fragment-token&view=compact",
    );

    expect(output).not.toContain("authorization-code");
    expect(output).not.toContain("encoded-token");
    expect(output).not.toContain("fragment-token");
    expect(output).toContain("client_id=public-client");
    expect(output).toContain("view=compact");
    expect(output).toContain(`code=${REDACTED}`);
  });

  test("redacts credentials in absolute URL userinfo and vendor-shaped parameters", () => {
    const output = redactUrlMetadata(
      "https://analyst:user-password@example.test/rpc?x-goog-api-key=google-secret&request_id=public-id",
    );

    expect(output).toBe(
      `https://${REDACTED}:${REDACTED}@example.test/rpc?x-goog-api-key=${REDACTED}&request_id=public-id`,
    );
  });

  test("preserves null and credential-free paths", () => {
    expect(redactUrlMetadata(null)).toBeNull();
    expect(redactUrlMetadata("/v1/items?sort=created_at&direction=desc")).toBe(
      "/v1/items?sort=created_at&direction=desc",
    );
  });
});
