/* Google Meet: who is speaking right now, read from Meet's own captions (turn on "CC").
 * Meet's class names are obfuscated and change often, so we rely only on stable things:
 * the captions region's aria-label and participant tiles' data-participant-id.
 * Sends {type: "meet-speaker", name, participants, at} to the extension on every change. */
(() => {
  const CAPTION_LABEL = /caption|субтитр|подпис/i;
  const MAX_NAME = 40;
  let lastName = null;
  let lastParticipants = "";

  function captionsRegion() {
    for (const el of document.querySelectorAll('[role="region"][aria-label], [aria-live][aria-label]')) {
      if (CAPTION_LABEL.test(el.getAttribute("aria-label") || "")) return el;
    }
    return null;
  }

  // Short, single-line texts inside an element, in document order.
  function shortTexts(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      if (t) out.push(t);
    }
    return out;
  }

  // Each caption block = speaker name + spoken text; the last block is the current speaker.
  function currentSpeaker(region) {
    const blocks = [...region.children].filter((b) => b.textContent.trim());
    const last = blocks[blocks.length - 1];
    if (!last) return "";
    const img = last.querySelector("img[alt]");
    if (img && img.alt.trim() && img.alt.length <= MAX_NAME) return img.alt.trim();
    const texts = shortTexts(last);
    // Name comes first and is short; the caption text follows.
    return texts.length > 1 && texts[0].length <= MAX_NAME ? texts[0] : "";
  }

  function participants() {
    const names = new Set();
    for (const tile of document.querySelectorAll("[data-participant-id]")) {
      const named = tile.querySelector("[data-self-name]");
      const name = (named && named.getAttribute("data-self-name")) || shortTexts(tile).find((t) => t.length <= MAX_NAME && !/^\d/.test(t));
      if (name && name.length <= MAX_NAME) names.add(name.trim());
    }
    return [...names].slice(0, 30);
  }

  function tick() {
    const region = captionsRegion();
    const name = region ? currentSpeaker(region) : "";
    const people = participants();
    const key = people.join("|");
    if (name === lastName && key === lastParticipants) return;
    lastName = name;
    lastParticipants = key;
    try {
      chrome.runtime.sendMessage({ type: "meet-speaker", name, participants: people, at: Date.now() }).catch(() => {});
    } catch (e) { /* extension reloaded: stop quietly */ clearInterval(timer); }
  }

  const timer = setInterval(tick, 400);
})();
