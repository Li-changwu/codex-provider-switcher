import assert from "node:assert/strict";
import test from "node:test";
import { createProviderWorkbenchHtml } from "../../src/ui/provider-webview";

test("renders a CSP-protected workbench with all approved workflows", () => {
  const html = createProviderWorkbenchHtml("nonce-value");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /nonce-value/);
  assert.match(html, /Provider configuration/);
  assert.match(html, /config\.toml/);
  assert.match(html, /auth\.json/);
  assert.match(html, /Save official Provider/);
  assert.match(html, /Sync session metadata/);
  assert.match(html, /Continue/);
  assert.match(html, /No session metadata needs synchronization/);
  assert.doesNotMatch(html, /OPENAI_API_KEY\s*[:=]\s*sk-/);
});
