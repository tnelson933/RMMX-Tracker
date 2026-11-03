import test from "node:test";
import assert from "node:assert/strict";
import { approvedLink, enforceApprovedLinks, enforceApprovedLinksDeep } from "./approvedLinks";

test("store and channel links stay; the old store search format is fixed", () => {
  assert.equal(approvedLink("https://www.rockymountainatvmc.com/search/go?w=Maxima%2010W-40"), "https://www.rockymountainatvmc.com/search/go?w=Maxima%2010W-40");
  assert.equal(approvedLink("https://www.rockymountainatv.com/search/go?w=chain"), "https://www.rockymountainatvmc.com/search/go?w=chain");
  assert.equal(approvedLink("https://www.rockymountainatvmc.com/search#q=Maxima+10W-40"), "https://www.rockymountainatvmc.com/search/go?w=Maxima%2010W-40");
  assert.equal(approvedLink("https://www.youtube.com/@rmatvmc/search?query=oil%20change"), "https://www.youtube.com/@rmatvmc/search?query=oil%20change");
  assert.equal(approvedLink("https://www.youtube.com/RockyMountainATVMC"), "https://www.youtube.com/RockyMountainATVMC");
});

test("competitors, other channels and individual videos are removed", () => {
  for (const url of [
    "https://www.revzilla.com/motorcycle-oil", "https://www.amazon.com/dp/B000", "https://www.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123", "https://www.youtube.com/@someotherchannel", "https://rockymountainatvmc.com.evil.com/x",
  ]) assert.equal(approvedLink(url), null, url);
});

test("a reply keeps our links and loses everyone else's", () => {
  const reply = "Grab Maxima 10W-40 — https://www.rockymountainatvmc.com/search#q=Maxima+10W-40. Or try https://www.revzilla.com/oil, or amazon.com. Watch: https://youtu.be/xyz.";
  assert.equal(enforceApprovedLinks(reply),
    "Grab Maxima 10W-40 — https://www.rockymountainatvmc.com/search/go?w=Maxima%2010W-40. Or try, or. Watch:.");
  assert.equal(enforceApprovedLinks("See [this guide](https://www.motosport.com/x) and [our video](https://www.youtube.com/@rmatvmc/search?query=chain)."),
    "See this guide and our video — https://www.youtube.com/@rmatvmc/search?query=chain.");
  assert.equal(enforceApprovedLinks("Torque the bolts to 10 N·m, then check 2.5 mm play."), "Torque the bolts to 10 N·m, then check 2.5 mm play.");
});

test("every text field of a plan is checked; server-made fields are left alone", () => {
  const plan = { phases: [{ name: "Warm up", notes: "Video: https://www.youtube.com/watch?v=1", imageUrl: "https://www.rmroost.com/api/storage/uploads/x.png" }] };
  assert.deepEqual(enforceApprovedLinksDeep(plan, ["imageUrl"]), { phases: [{ name: "Warm up", notes: "Video:", imageUrl: "https://www.rmroost.com/api/storage/uploads/x.png" }] });
});
