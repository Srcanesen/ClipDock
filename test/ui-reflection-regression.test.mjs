// Plan adım 1 — kırmızı baseline. Production/source/install kodu değiştirmez.
// Yalnız topoloji ve kaynak contract semptomlarını yakalar; bu adım sonunda kırmızı kalması beklenir.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ROOT = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins';

test('A — active Resolve Workflow Integration topology: single com.clipdock.app manifest', async (t) => {
  if (process.env.CLIPDOCK_VERIFY_LOCAL_TOPOLOGY !== '1') {
    t.skip('Local topology check skipped — set CLIPDOCK_VERIFY_LOCAL_TOPOLOGY=1 to verify active plugin topology (requires single com.clipdock.app manifest)');
    return;
  }
  if (!existsSync(PLUGIN_ROOT)) {
    t.skip(`Resolve Workflow Integration Plugins root not found at ${PLUGIN_ROOT} — platform-appropriate skip`);
    return;
  }

  // Read-only scan: never move/delete backup.
  const entries = readdirSync(PLUGIN_ROOT, { withFileTypes: true });
  const manifestHits = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGIN_ROOT, entry.name, 'manifest.xml');
    if (!existsSync(manifestPath)) continue;
    const xml = readFileSync(manifestPath, 'utf8');
    if (/<Id>\s*com\.clipdock\.app\s*<\/Id>/.test(xml)) manifestHits.push(manifestPath);
  }
  const rootManifest = path.join(PLUGIN_ROOT, 'manifest.xml');
  if (existsSync(rootManifest)) {
    const xml = readFileSync(rootManifest, 'utf8');
    if (/<Id>\s*com\.clipdock\.app\s*<\/Id>/.test(xml)) manifestHits.push(rootManifest);
  }

  assert.equal(
    manifestHits.length,
    1,
    `active plugin root must contain exactly one manifest with <Id>com.clipdock.app</Id> — found ${manifestHits.length}: ${manifestHits.join(', ') || '(none)'}; expected single com.clipdock.app and backup com.clipdock.app.backup-* must not share the same Id in the scanned root`,
  );
});

test('B — canonical UI contracts: valid Common output disclosure + thumbnail fallbacks', () => {
  const html = readFileSync(path.join(root, 'static/index.html'), 'utf8');
  const css = readFileSync(path.join(root, 'static/css/styles.css'), 'utf8');
  const renderer = readFileSync(path.join(root, 'src/renderer.ts'), 'utf8');
  const errors = [];

  const detailsTagMatch = html.match(/<details[^>]*\bid\s*=\s*["']common-output["'][^>]*>/i);
  const hasDetails = Boolean(detailsTagMatch);
  const detailsTag = detailsTagMatch?.[0] ?? '';
  const hasOpenAttr = /\bopen\b/i.test(detailsTag);
  const hasSummary = hasDetails
    ? /<details[^>]*\bid\s*=\s*["']common-output["'][\s\S]*?<summary[^>]*>[\s\S]*?common-output-title/i.test(html) ||
      /<details[^>]*\bid\s*=\s*["']common-output["'][\s\S]*?<summary[^>]*>[\s\S]*?Common output/i.test(html)
    : false;
  const hasSectionCommonOutput = /<section[^>]*\bid\s*=\s*["']common-output["']/i.test(html);
  const commonSummary = html.match(/<summary\s+class=["']common-output-heading["']>([\s\S]*?)<\/summary>/i)?.[1] ?? '';
  // Phase 2 copy consolidation: summary hint removed — single legend (common-output-legend)
  // directly under heading now carries the override model (common defaults apply to newly
  // staged items; item overrides win; defaults never change retroactively; handoff after download).
  const hasPhrasingOnlyTitle = /<span\s+class=["']common-output-title-group["']>\s*<span\s+id=["']common-output-title["']\s+role=["']heading["']\s+aria-level=["']2["']>Common output<\/span>\s*<\/span>/.test(commonSummary);
  const hasNoSummaryHint = !/<span\s+class=["']hint["']>/.test(commonSummary);
  const legendMatch = html.match(/<p\s+class=["']hint\s+common-output-legend["'][^>]*>([\s\S]*?)<\/p>/i);
  const legendText = legendMatch?.[1] ?? '';
  const hasLegend = Boolean(legendMatch);
  const legendCoversModel = /Common defaults.*newly staged/i.test(legendText) && /item overrides.*only that item/i.test(legendText) && /never change.*common defaults/i.test(legendText) && /Handoff.*after download/i.test(legendText);
  const hasRedundantHints = /Applied to items staged from now on|Only this item|Common defaults stay unchanged/.test(html) && !legendCoversModel;

  if (!hasDetails || hasOpenAttr || !hasSummary || hasSectionCommonOutput || !hasPhrasingOnlyTitle || !hasNoSummaryHint || !hasLegend || !legendCoversModel || hasRedundantHints) {
    const hint = [
      hasSectionCommonOutput ? 'found <section id="common-output"> (always-visible) — expected <details>' : null,
      !hasDetails ? 'missing <details id="common-output">' : null,
      hasOpenAttr ? 'details has forbidden open attribute (must be default closed)' : null,
      !hasSummary ? 'missing <summary> with Common output title inside details' : null,
      !hasPhrasingOnlyTitle ? 'summary must use phrasing-only spans with #common-output-title[role="heading"][aria-level="2"] (no hint inside summary)' : null,
      !hasNoSummaryHint ? 'summary must not contain a hint span (consolidated into legend)' : null,
      !hasLegend ? 'missing <p class="hint common-output-legend"> directly under heading' : null,
      !legendCoversModel ? 'legend must cover: common defaults apply to newly staged items; item overrides win; defaults never change retroactively; handoff after download' : null,
      hasRedundantHints ? 'redundant per-group hints still present (Applied to items / Only this item / Common defaults stay unchanged should be consolidated)' : null,
    ]
      .filter(Boolean)
      .join('; ');
    errors.push(
      `Common output must be an accessible disclosure default closed: <details id="common-output"><summary>…Common output…</summary> with no open attribute — ${hint || 'contract not met'}; line 41 currently is <section id="common-output"> and always-visible (SHA 14254a…)`,
    );
  }
  // Phase 2: feed toolbar must have exactly one live status line (youtube-search-status)
  // and no separate provider hint node; the status line must carry provider context.
  const hasProviderHintNode = /id=["']provider-hint["']/.test(html);
  const feedToolbarMatch = html.match(/<div\s+class=["']feed-toolbar["'][\s\S]*?<\/div>/i)?.[0] ?? '';
  const hasSingleStatus = /id=["']youtube-search-status["']/.test(feedToolbarMatch);
  const hasNoExtraHintInToolbar = !hasProviderHintNode;
  const hasStatusProviderContext = /YouTube.*Search to browse videos|Pexels.*search|Pinterest.*Pins/i.test(feedToolbarMatch) || /YouTube.*Search/i.test(html.match(/id=["']youtube-search-status["'][^>]*>([^<]*)/i)?.[1] ?? '');
  if (hasProviderHintNode || !hasSingleStatus || !hasNoExtraHintInToolbar) {
    const hint2 = [
      hasProviderHintNode ? 'found #provider-hint (must be removed; single live status line remains)' : null,
      !hasSingleStatus ? 'missing #youtube-search-status in feed toolbar' : null,
    ].filter(Boolean).join('; ');
    errors.push(`Feed toolbar must have exactly one live status line (#youtube-search-status) carrying provider context — ${hint2 || 'contract not met'}`);
  }

  const hasAspectRatio = /aspect-ratio\s*:\s*16\s*\/\s*9/.test(css);
  const supportsStart = css.search(/@supports\s+not\s*\(\s*aspect-ratio/i);
  const unconditionalCss = supportsStart < 0 ? css : css.slice(0, supportsStart) + css.slice(css.indexOf('}', supportsStart) + 1);
  const spacerDisabled = /\.result-card-thumbnail\.card-thumb::before\s*,[\s\S]*?\.result-card-thumbnail\.card-thumb::before\s*\{[^}]*content\s*:\s*none[^}]*display\s*:\s*none/s.test(unconditionalCss);
  const normalFlowImage = /\.result-card-thumbnail\.card-thumb\s+img\s*,[\s\S]*?\.result-card-thumbnail\.card-thumb\s+img\s*\{[^}]*position\s*:\s*static[^}]*height\s*:\s*auto[^}]*aspect-ratio\s*:\s*16\s*\/\s*9/s.test(unconditionalCss);
  const normalFlowFallback = /\.result-card-thumbnail\.card-thumb\s+\.thumbnail-fallback-label\s*,[\s\S]*?\.result-card-thumbnail\.card-thumb\s+\.thumbnail-fallback-label\s*\{[^}]*position\s*:\s*static[^}]*height\s*:\s*auto[^}]*aspect-ratio\s*:\s*16\s*\/\s*9/s.test(unconditionalCss);
  const cardRule = css.match(/\.youtube-search-result\.clipdock-result-card,[\s\S]*?\.youtube-search-result\.result-card\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const legacyGrid = /grid-template-columns\s*:\s*minmax\(280px,\s*42%\)\s+minmax\(0,\s*1fr\)/.test(cardRule);
  const clampGrid = /grid-template-columns\s*:\s*clamp\(280px,\s*42%,\s*430px\)\s+minmax\(0,\s*1fr\)/.test(cardRule);
  const hasStacked = /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/.test(cardRule);
  const hasOverflowTrap = /overflow\s*:\s*hidden/.test(cardRule);
  const hasMinHeightTrap = /min-height\s*:\s*0/.test(cardRule);

  if (!hasAspectRatio) errors.push('CSS must still declare aspect-ratio: 16 / 9 for modern browsers');
  if (!spacerDisabled) errors.push('Card thumbnails must disable the legacy ::before spacer to avoid double height.');
  if (!normalFlowImage) errors.push('Card thumbnail images must establish 16:9 height in normal flow.');
  if (!normalFlowFallback) errors.push('Card thumbnail fallbacks must establish 16:9 height in normal flow.');
  // CSS aspect-ratio owns 16:9 since D Home Grid port - stacked single-column required, legacy traps removed
  if (!hasStacked || legacyGrid || clampGrid || hasOverflowTrap || hasMinHeightTrap) errors.push('Card grid must be stacked single-column (minmax(0,1fr)) with no legacy minmax(280px)/clamp fallback and no overflow:hidden/min-height:0 traps - CSS aspect-ratio owns 16:9 since D Home Grid port');
  if (!/function renderPexelsSearchResults\(\)[\s\S]*?appendResultThumbnail\(thumb, item\.thumbnailUrl, item\.title\)/.test(renderer)) {
    errors.push('Pexels must use the shared thumbnail loader with graceful error fallback.');
  }

  assert.equal(errors.length, 0, errors.join(' | '));
});
