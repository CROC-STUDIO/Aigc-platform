import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getProductInfoItem,
  listProductInfoItems,
  loadProductInfoAsset
} from "../../server/wangzhuan/product-info-library.mjs";

async function makeProductInfoRoot() {
  const root = await mkdtemp(join(tmpdir(), "wz-product-info-"));
  const productDir = join(root, "DemoProduct");
  const assetsDir = join(productDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(productDir, "product-metadata.json"), JSON.stringify({
    productName: "Demo Product",
    sourceUrl: "https://play.google.com/store/apps/details?id=demo.product",
    description: "Demo product description.",
    coreSellingPoints: ["Short dramas", "Reward feedback"]
  }, null, 2));
  await writeFile(join(assetsDir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(assetsDir, "screenshot-01.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

test("product info library lists local products with usable metadata and asset previews", async () => {
  const productInfoRoot = await makeProductInfoRoot();
  const result = await listProductInfoItems({ productInfoRoot });

  assert.equal(result.rootAvailable, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, "DemoProduct");
  assert.equal(result.items[0].productName, "Demo Product");
  assert.equal(result.items[0].assetSummary.iconCount, 1);
  assert.equal(result.items[0].assetSummary.screenshotCount, 1);
  assert.match(result.items[0].primaryIconUrl, /\/api\/wangzhuan\/product-info\/DemoProduct\/assets\/icon\.png/);
});

test("product info detail exposes description, selling points, and mapped product assets", async () => {
  const productInfoRoot = await makeProductInfoRoot();
  const result = await getProductInfoItem({ productInfoRoot }, "DemoProduct");
  const product = result.product;

  assert.equal(product.productName, "Demo Product");
  assert.equal(product.description, "Demo product description.");
  assert.deepEqual(product.coreSellingPoints, ["Short dramas", "Reward feedback"]);
  assert.equal(product.assets[0].assetKey, "productIcon");
  assert.equal(product.assets[1].assetKey, "productScreenshot");
  assert.equal(product.productBrief.assetSlots.productIcon, product.assets[0].previewUrl);
});

test("product info asset loader rejects path traversal and returns safe binary assets", async () => {
  const productInfoRoot = await makeProductInfoRoot();
  const asset = await loadProductInfoAsset({ productInfoRoot }, "DemoProduct", "icon.png");

  assert.equal(asset.mimeType, "image/png");
  assert.equal(asset.fileName, "icon.png");
  await assert.rejects(
    () => loadProductInfoAsset({ productInfoRoot }, "DemoProduct", "../product-metadata.json"),
    /产品素材文件名不合法/
  );
});
