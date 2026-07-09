import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = Buffer.alloc(0);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    this.body = Buffer.concat([this.body, chunk]);
    this.emit("finish");
  }
}

async function makeContext() {
  const root = await mkdtemp(join(tmpdir(), "wz-product-info-router-"));
  const productInfoRoot = join(root, "product_info");
  const productDir = join(productInfoRoot, "DemoProduct");
  const assetsDir = join(productDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(productDir, "product-metadata.json"), JSON.stringify({
    productName: "Demo Product",
    description: "Demo description",
    coreSellingPoints: ["Drama", "Rewards"]
  }));
  await writeFile(join(assetsDir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userId: "tester",
    userProjectRoot: root,
    sharedProjectRoot: root,
    productInfoRoot,
    config: {},
    readJson: async () => ({}),
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    currentProjectRoot: () => root,
    currentBaseProjectRoot: () => root
  };
}

async function call(method, path, context) {
  const req = { method, url: path };
  const res = new TestResponse();
  await handleWangzhuanRequest(req, res, new URL(path, "http://localhost"), context);
  return res;
}

test("product info router exposes list, detail, and inline asset preview", async () => {
  const context = await makeContext();
  const listed = await call("GET", "/api/wangzhuan/product-info", context);
  const listPayload = JSON.parse(listed.body.toString("utf8"));

  assert.equal(listed.statusCode, 200);
  assert.equal(listPayload.data.items[0].productName, "Demo Product");

  const detail = await call("GET", "/api/wangzhuan/product-info/DemoProduct", context);
  const detailPayload = JSON.parse(detail.body.toString("utf8"));

  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detailPayload.data.product.coreSellingPoints, ["Drama", "Rewards"]);

  const asset = await call("GET", "/api/wangzhuan/product-info/DemoProduct/assets/icon.png", context);
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["Content-Type"], "image/png");
  assert.equal(asset.body.length, 4);
});
