import assert from "node:assert/strict";
import test from "node:test";
import { brandedEmailHtml, emailAssetBase, esc } from "./emailLayout";

test("emails use public image addresses, never a local dev URL", () => {
  assert.equal(emailAssetBase("https://www.rmroost.com/"), "https://www.rmroost.com");
  assert.equal(emailAssetBase("http://rmtracker.localhost:19869"), "https://www.rmroost.com");
  assert.equal(emailAssetBase("https://localhost:8443"), "https://www.rmroost.com");
});

test("branded email: brand, button, footer, and escaped text", () => {
  const html = brandedEmailHtml({
    appUrl: "https://www.rmroost.com", preheader: "p", eyebrow: "Organizer invite", heading: "You've been invited",
    paragraphs: [`Hi ${esc("<b>Dan</b>")},`], button: { label: "Set Up My Account", url: "https://www.rmroost.com/setup-account?token=x" },
  });
  assert.match(html, /brand\/rm-roost-banner-640\.png/);
  assert.match(html, /#B30000/);
  assert.match(html, /href="https:\/\/www\.rmroost\.com\/setup-account\?token=x"/);
  assert.match(html, /owned and operated by Rocky Mountain ATV Inc\./);
  assert.match(html, /Hi &lt;b&gt;Dan&lt;\/b&gt;,/);
  assert.match(html, /You&#39;ve been invited/);
});
