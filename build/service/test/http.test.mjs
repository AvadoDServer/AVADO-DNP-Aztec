import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedHost, checkCsrf, CSP } from "../src/lib/http.mjs";

const names = ["aztec.my.ava.do"];

test("host allow-list: own name, IPs and localhost only", () => {
  assert.equal(isAllowedHost("aztec.my.ava.do", names), true);
  assert.equal(isAllowedHost("aztec.my.ava.do:80", names), true);
  assert.equal(isAllowedHost("aztec.my.ava.do:443", names), true);
  assert.equal(isAllowedHost("aztec.my.ava.do:8080", names), false);
  assert.equal(isAllowedHost("172.33.0.5", names), true);
  assert.equal(isAllowedHost("localhost:3000", names), true);
  assert.equal(isAllowedHost("evil.example.com", names), false);
  assert.equal(isAllowedHost(undefined, names), false);
});

test("state-changing requests need the custom header and the same origin", () => {
  const base = { method: "POST", headers: { host: "aztec.my.ava.do" } };
  assert.match(checkCsrf(base), /X-Avado-Request/);
  assert.equal(checkCsrf({ ...base, headers: { ...base.headers, "x-avado-request": "1" } }), null);
  assert.match(
    checkCsrf({ ...base, headers: { ...base.headers, "x-avado-request": "1", origin: "http://evil.example.com" } }),
    /Cross-origin/,
  );
  assert.equal(
    checkCsrf({ ...base, headers: { ...base.headers, "x-avado-request": "1", origin: "http://aztec.my.ava.do" } }),
    null,
  );
  assert.match(
    checkCsrf({ ...base, headers: { ...base.headers, "x-avado-request": "1", "sec-fetch-site": "cross-site" } }),
    /Cross-site/,
  );
  assert.equal(checkCsrf({ method: "GET", headers: {} }), null);
});

test("only the AVADO Admin may show the page in a frame", () => {
  const fa = /frame-ancestors ([^;]+)/.exec(CSP)[1].trim().split(/\s+/);
  assert.deepEqual(fa, ["'self'", "http://my.ava.do", "http://*.my.ava.do"]);
});
