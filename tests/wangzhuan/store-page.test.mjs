import assert from "node:assert/strict";
import test from "node:test";

import { inspectStorePage } from "../../server/wangzhuan/store-page.mjs";

function lookupResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test("App Store inspect uses Apple Lookup and normalizes metadata candidates", async () => {
  const calls = [];
  const context = {
    fetch: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return lookupResponse({
        resultCount: 1,
        results: [{
          trackName: "ReelMate: Drama & Chat",
          sellerName: "Rellmate Inc.",
          artistName: "Rellmate",
          primaryGenreName: "Entertainment",
          description: "Watch addictive short dramas.\nChat with story characters after dramatic twists.",
          releaseNotes: "New drama stories added.",
          artworkUrl512: "https://is1-ssl.mzstatic.com/image/icon.png",
          screenshotUrls: [
            "https://is1-ssl.mzstatic.com/image/screen1.png",
            "https://is1-ssl.mzstatic.com/image/screen2.png"
          ],
          ipadScreenshotUrls: ["https://is1-ssl.mzstatic.com/image/ipad1.png"],
          previewUrl: "https://video-ssl.itunes.apple.com/preview.m4v",
          trackContentRating: "12+",
          trackId: 1234567890,
          bundleId: "com.rellmate.drama",
          trackViewUrl: "https://apps.apple.com/us/app/reelmate-drama-chat/id1234567890",
          averageUserRating: 4.7,
          userRatingCount: 3456,
          languageCodesISO2A: ["EN", "PT"],
          version: "1.2.3",
          currentVersionReleaseDate: "2026-07-01T00:00:00Z",
          minimumOsVersion: "15.0",
          fileSizeBytes: "123456789"
        }]
      });
    }
  };

  const result = await inspectStorePage(context, {
    url: "https://apps.apple.com/us/app/reelmate-drama-chat/id1234567890",
    primaryLanguage: "en-US"
  });

  assert.equal(result.store, "app_store");
  assert.equal(result.provider.name, "apple_lookup");
  assert.equal(result.candidates.productName, "ReelMate: Drama & Chat");
  assert.equal(result.candidates.developer, "Rellmate Inc.");
  assert.equal(result.candidates.category, "Entertainment");
  assert.equal(result.candidates.icon.url, "https://is1-ssl.mzstatic.com/image/icon.png");
  assert.equal(result.candidates.screenshots.length, 3);
  assert.equal(result.candidates.videoPreviews.length, 1);
  assert.ok(result.candidates.visibleTexts.includes("ReelMate: Drama & Chat"));
  assert.ok(result.candidates.coreSellingPoints.includes("Watch addictive short dramas."));
  assert.equal(result.metadata.appId, "1234567890");
  assert.equal(result.metadata.bundleId, "com.rellmate.drama");
  assert.equal(result.metadata.storeUrl, "https://apps.apple.com/us/app/reelmate-drama-chat/id1234567890");
  assert.equal(result.metadata.contentRating, "12+");
  assert.deepEqual(result.metadata.sourceLanguages, ["EN", "PT"]);
  assert.equal(result.metadata.rating, 4.7);
  assert.equal(result.metadata.ratingCount, 3456);
  assert.equal(result.metadata.version, "1.2.3");
  assert.equal(result.metadata.minimumOsVersion, "15.0");
  assert.equal(result.metadata.fileSizeBytes, "123456789");
  assert.equal(result.productBrief.productName, "ReelMate: Drama & Chat");
  assert.equal(result.productBrief.contentRating, "12+");
  assert.ok(result.productBrief.mustShow.includes("产品 logo/icon"));
  assert.ok(result.productBrief.mustShow.includes("产品截图中的真实 UI、页面布局和功能入口"));
  assert.equal(result.productBrief.assetSlots.productIcon, "https://is1-ssl.mzstatic.com/image/icon.png");
  assert.equal(result.productBrief.assetSlots.productScreenshots.length, 3);
  assert.equal(result.productBrief.assetSlots.productRecording, "https://video-ssl.itunes.apple.com/preview.m4v");
  assert.match(result.productBrief.mustAvoid.join("\n"), /不要编造商店页未提供的价格/);

  assert.equal(calls.length, 1);
  const lookupUrl = new URL(calls[0].url);
  assert.equal(lookupUrl.hostname, "itunes.apple.com");
  assert.equal(lookupUrl.searchParams.get("id"), "1234567890");
  assert.equal(lookupUrl.searchParams.get("country"), "us");
  assert.equal(lookupUrl.searchParams.get("lang"), "en_us");
  assert.equal(lookupUrl.searchParams.get("entity"), "software");
});

test("App Store inspect supports id query links and explicit country/language", async () => {
  const calls = [];
  const context = {
    fetch: async (url) => {
      calls.push(url.toString());
      return lookupResponse({
        results: [{
          trackName: "Demo App",
          artistName: "Demo Dev",
          primaryGenreName: "Lifestyle",
          description: "Demo description.",
          screenshotUrls: []
        }]
      });
    }
  };

  const result = await inspectStorePage(context, {
    url: "https://apps.apple.com/app/id987654321?mt=8",
    country: "BR",
    language: "pt-BR"
  });

  assert.equal(result.candidates.productName, "Demo App");
  const lookupUrl = new URL(calls[0]);
  assert.equal(lookupUrl.searchParams.get("id"), "987654321");
  assert.equal(lookupUrl.searchParams.get("country"), "br");
  assert.equal(lookupUrl.searchParams.get("lang"), "pt_br");
});

test("Google Play inspect fetches store HTML and normalizes app metadata candidates", async () => {
  const calls = [];
  const html = `
    <html>
      <head>
        <meta property="og:title" content="ReelMate: Drama &amp; Chat - Apps on Google Play">
        <meta property="og:description" content="Watch addictive short dramas. Chat with story characters after dramatic twists.">
        <meta property="og:image" content="https://play-lh.googleusercontent.com/icon=w240-h480">
        <script type="application/ld+json">
          {
            "@type": "SoftwareApplication",
            "name": "ReelMate: Drama & Chat",
            "author": { "name": "Rellmate Studio" },
            "applicationCategory": "Entertainment",
            "contentRating": "Teen",
            "aggregateRating": { "ratingValue": "4.6", "ratingCount": "98765" },
            "description": "Watch addictive short dramas. Chat with story characters after dramatic twists.",
            "image": "https://play-lh.googleusercontent.com/icon=w240-h480",
            "screenshot": [
              "https://play-lh.googleusercontent.com/screen1=w526-h296",
              "https://play-lh.googleusercontent.com/screen2=w526-h296"
            ]
          }
        </script>
      </head>
      <body>
        <img src="https://play-lh.googleusercontent.com/screen3=w526-h296">
        <a href="https://www.youtube.com/watch?v=abc123XYZ_-">preview</a>
      </body>
    </html>
  `;
  const context = {
    fetch: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return {
        ok: true,
        status: 200,
        text: async () => html
      };
    }
  };

  const result = await inspectStorePage(context, {
    url: "https://play.google.com/store/apps/details?id=com.rellmate.drama.shortvideo",
    country: "BR",
    language: "pt-BR"
  });

  assert.equal(result.store, "google_play");
  assert.equal(result.provider.name, "google_play_html");
  assert.equal(result.appId, "com.rellmate.drama.shortvideo");
  assert.equal(result.candidates.productName, "ReelMate: Drama & Chat");
  assert.equal(result.candidates.developer, "Rellmate Studio");
  assert.equal(result.candidates.category, "Entertainment");
  assert.equal(result.candidates.icon.url, "https://play-lh.googleusercontent.com/icon=w240-h480");
  assert.equal(result.candidates.screenshots.length, 3);
  assert.equal(result.candidates.videoPreviews.length, 1);
  assert.ok(result.candidates.visibleTexts.includes("ReelMate: Drama & Chat"));
  assert.ok(result.candidates.coreSellingPoints.includes("Watch addictive short dramas."));
  assert.equal(result.metadata.appId, "com.rellmate.drama.shortvideo");
  assert.equal(result.metadata.storeUrl, "https://play.google.com/store/apps/details?id=com.rellmate.drama.shortvideo&hl=pt_BR&gl=BR");
  assert.equal(result.metadata.contentRating, "Teen");
  assert.equal(result.metadata.rating, 4.6);
  assert.equal(result.metadata.ratingCount, 98765);
  assert.equal(result.productBrief.productName, "ReelMate: Drama & Chat");
  assert.equal(result.productBrief.category, "Entertainment");
  assert.equal(result.productBrief.assetSlots.productIcon, "https://play-lh.googleusercontent.com/icon=w240-h480");
  assert.equal(result.productBrief.assetSlots.productScreenshots.length, 3);
  assert.equal(result.productBrief.assetSlots.productRecording, "https://www.youtube.com/watch?v=abc123XYZ_-");

  assert.equal(calls.length, 1);
  const pageUrl = new URL(calls[0].url);
  assert.equal(pageUrl.hostname, "play.google.com");
  assert.equal(pageUrl.searchParams.get("id"), "com.rellmate.drama.shortvideo");
  assert.equal(pageUrl.searchParams.get("gl"), "BR");
  assert.equal(pageUrl.searchParams.get("hl"), "pt_BR");
  assert.equal(calls[0].options.headers["Accept-Language"], "pt-BR");
});

test("Google Play inspect falls back to meta tags when structured data is missing", async () => {
  const context = {
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <meta property="og:title" content="Demo Play App - Apps on Google Play">
        <meta property="og:description" content="A practical demo app for daily workflows.">
        <meta property="og:image" content="https://play-lh.googleusercontent.com/demo-icon">
        <img src="https://play-lh.googleusercontent.com/demo-screen">
      `
    })
  };

  const result = await inspectStorePage(context, {
    url: "https://play.google.com/store/apps/details?id=com.example.demo"
  });

  assert.equal(result.candidates.productName, "Demo Play App");
  assert.equal(result.candidates.description, "A practical demo app for daily workflows.");
  assert.equal(result.candidates.icon.url, "https://play-lh.googleusercontent.com/demo-icon");
  assert.equal(result.candidates.screenshots.length, 1);
});
