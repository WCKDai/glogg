#!/usr/bin/env tsx
import {
  cleanAndAutopsyHtml,
  compileSearchQuery,
  CURATED_INDIE_INDEX,
  DEFAULT_SLOP_DOMAINS,
  exportUBlacklistRuleset,
  SearchLensId,
} from '../src/core/index.js';
import {
  getContainerStackStatus,
  runContainerOrchestrationAction,
} from '../server/containerManager.js';
import { executeFederatedSearch } from '../server/federatedSearch.js';
import { configureNetwork } from '../server/net.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const BLUE = '\x1b[38;2;59;130;246m';
const GREEN = '\x1b[38;2;16;185;129m';
const CYAN = '\x1b[38;2;6;182;212m';
const PURPLE = '\x1b[38;2;139;92;246m';
const ROSE = '\x1b[38;2;244;63;94m';
const AMBER = '\x1b[38;2;245;158;11m';

function printBanner() {
  console.log(`${BLUE}${BOLD}● glogg.app${RESET} ${DIM}— Anti-Slop Meta-Indexer, P2P/DHT/Usenet, Fediverse & Clean Reader CLI${RESET}`);
}

function printHelp() {
  printBanner();
  console.log(`
${BOLD}USAGE${RESET}
  glogg <command> [options]

${BOLD}COMMANDS${RESET}
  ${BLUE}search${RESET} <query>            Federated search across 20 real-web, Fediverse, P2P DHT & Usenet indexes
    --lens <id>             Lens: all | small-web | fediverse | p2p-magnet | usenet-nzb | deep-archives | raw-news | primary | forums | pre-llm
    --uncensored            Enable 18+ Uncensored & Raw mode (adult DHT/NZB, SafeSearch=0, FOIA/OSINT)
    --max-per-domain <n>    Max results per domain (default: 1)
    --json                  Output raw JSON response

  ${BLUE}inspect${RESET} <url>             Deshittify a web page, strip trackers, collapse SEO fluff & extract primary sources
    --json                  Output raw JSON autopsy report

  ${BLUE}containers${RESET} [subcommand]   Manage self-hosted Docker / Podman / Colima stack (Bitmagnet, IPFS, SearXNG, Prowlarr, NZBHydra2, Tor)
    status                  Inspect runtime & container status (default)
    up [serviceId]          Deploy full stack or a specific container
    down                    Stop full container stack
    start-daemon            Start Colima / Docker / Podman daemon

  ${BLUE}atlas${RESET} [category]          Browse the hand-curated Real-Web Atlas (${CURATED_INDIE_INDEX.length} verified sites & protocols)
  ${BLUE}rules${RESET}                     Export uBlacklist / Glogg anti-slop ruleset to stdout
  ${BLUE}query-plan${RESET} <query>        Compile an anti-slop search query plan & escape hatch URLs
`);
}

export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  const hasFlag = (flag: string) => args.includes(flag);
  const getFlagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  };

  if (command === 'query-plan') {
    const queryWords = args
      .slice(1)
      .filter((a) => !a.startsWith('--'));
    const q = queryWords.join(' ').trim();
    if (!q) {
      console.error('Error: Please provide a search query.');
      return 1;
    }
    const lens = (getFlagValue('--lens') as SearchLensId) || 'all';
    const plan = compileSearchQuery(q, { lens });
    if (hasFlag('--json')) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    printBanner();
    console.log(`\n${BOLD}Synthesized Query:${RESET} ${BLUE}${plan.synthesizedQuery}${RESET}\n`);
    console.log(`${BOLD}Escape Hatch Meta-Links:${RESET}`);
    for (const esc of plan.escapeUrls) {
      console.log(`  ${CYAN}${esc.name.padEnd(32)}${RESET} ${esc.url}`);
    }
    return 0;
  }

  if (command === 'search') {
    const lens = (getFlagValue('--lens') as SearchLensId) || 'all';
    const uncensoredMode = hasFlag('--uncensored') || hasFlag('--18+');
    const maxPerDomain = Number(getFlagValue('--max-per-domain') ?? 1);
    const jsonMode = hasFlag('--json');

    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--lens' || arg === '--max-per-domain') {
        i++;
        continue;
      }
      if (arg.startsWith('--')) continue;
      positional.push(arg);
    }

    const q = positional.join(' ').trim();
    if (!q) {
      console.error('Error: Please provide a search query.');
      return 1;
    }

    const response = await executeFederatedSearch(q, {
      lens,
      uncensoredMode,
      maxPerDomain,
    });

    if (jsonMode) {
      console.log(JSON.stringify(response, null, 2));
      return 0;
    }

    printBanner();
    console.log(
      `${DIM}Query:${RESET} "${BOLD}${response.query}${RESET}" · ${DIM}Lens:${RESET} ${BLUE}${response.lens}${RESET} · ${DIM}18+ Uncensored:${RESET} ${
        response.uncensoredMode ? `${ROSE}ON${RESET}` : 'OFF'
      } · ${DIM}Time:${RESET} ${response.metrics.durationMs}ms`
    );
    console.log(
      `${GREEN}${response.metrics.surfacedCount} surfaced${RESET} · ${CYAN}${response.metrics.p2pCount} P2P/NZB${RESET} · ${PURPLE}${response.metrics.fediverseCount} Fediverse${RESET} · ${ROSE}${response.metrics.filteredSlopCount} slop/dupes stripped${RESET} (${Math.round(
        response.metrics.domainDiversityRatio * 100
      )}% domain diversity)\n`
    );

    if (response.instantAnswer) {
      const ia = response.instantAnswer;
      console.log(`${BOLD}${GREEN}── Instant Direct Answer (${ia.confidence.toUpperCase()}) ──${RESET}`);
      console.log(`  ${BOLD}${ia.title}${RESET}${ia.subtitle ? ` ${DIM}· ${ia.subtitle}${RESET}` : ''}`);
      console.log(`  ${ia.directAnswer}`);
      if (ia.codeBlock) {
        console.log(`  ${CYAN}${ia.codeBlock.split('\n').slice(0, 6).join('\n  ')}${RESET}`);
      }
      if (ia.primarySourceUrl) {
        console.log(`  ${BLUE}Source: ${ia.primarySourceUrl}${RESET}`);
      }
      console.log('');
    }

    if (response.p2pResults.length > 0) {
      console.log(`${BOLD}${CYAN}── P2P DHT / Bitmagnet & Usenet NZB Releases (Top 5) ──${RESET}`);
      for (const item of response.p2pResults.slice(0, 5)) {
        const p2p = item.p2p!;
        const proto = p2p.protocol === 'bittorrent-dht' ? 'BT-DHT' : 'USENET';
        const swarm =
          p2p.protocol === 'bittorrent-dht'
            ? `${p2p.seeders ?? 0}S/${p2p.leechers ?? 0}L`
            : `${p2p.newsgroup || 'NZB'}`;
        console.log(
          `  [${BLUE}${proto}${RESET}] ${BOLD}${item.title.slice(0, 68)}${RESET} (${p2p.sizeFormatted} · ${swarm})`
        );
        console.log(`           ${DIM}${p2p.magnetUri || p2p.nzbUrl || item.url}${RESET}`);
      }
      console.log('');
    }

    console.log(`${BOLD}${BLUE}── Surfaced Real-Web, Fediverse & Primary Results ──${RESET}`);
    for (const item of response.results.slice(0, 15)) {
      const badgeColor =
        item.verdict === 'primary-source'
          ? BLUE
          : item.verdict === 'indie-gem'
          ? GREEN
          : item.verdict === 'fediverse-node'
          ? PURPLE
          : CYAN;
      console.log(
        `  ${badgeColor}[${item.verdict.toUpperCase()}]${RESET} ${BOLD}${item.title}${RESET} ${DIM}(${item.domain} · Signal ${item.authenticityScore}% · Slop ${item.slopScore}%)${RESET}`
      );
      console.log(`    ${BLUE}${item.url}${RESET}`);
      console.log(`    ${DIM}${item.snippet.slice(0, 140)}${RESET}\n`);
    }
    return 0;
  }

  if (command === 'inspect') {
    const targetUrl = args[1];
    if (!targetUrl || targetUrl.startsWith('--')) {
      console.error('Error: Please provide a URL to inspect.');
      return 1;
    }
    const normalized = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;
    const res = await fetch(normalized);
    const html = await res.text();
    const report = cleanAndAutopsyHtml(html, normalized);

    if (hasFlag('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    printBanner();
    console.log(`\n${BOLD}${report.title}${RESET} (${BLUE}${report.domain}${RESET})`);
    console.log(
      `${GREEN}Bloat Reduced: ${report.stats.bloatReductionPercent}%${RESET} · ${ROSE}Trackers Killed: ${report.stats.totalScriptsRemoved}${RESET} · ${AMBER}Affiliates Disarmed: ${report.stats.affiliateLinksDisarmed}${RESET} · ${BLUE}Primary Citations: ${report.primarySources.length}${RESET}\n`
    );

    if (report.primarySources.length > 0) {
      console.log(`${BOLD}${BLUE}Primary Sources Cited:${RESET}`);
      for (const ps of report.primarySources) {
        console.log(`  • [${ps.sourceTypeLabel || 'Primary'}] ${ps.text} → ${BLUE}${ps.url}${RESET}`);
      }
      console.log('');
    }

    if (report.coreTakeaway) {
      console.log(`${BOLD}Core Takeaway:${RESET}\n  ${report.coreTakeaway}\n`);
    }
    return 0;
  }

  if (command === 'containers') {
    const sub = args[1] || 'status';
    if (sub === 'status') {
      const stack = await getContainerStackStatus();
      if (hasFlag('--json')) {
        console.log(JSON.stringify(stack, null, 2));
        return 0;
      }
      printBanner();
      console.log(
        `\n${BOLD}Container Runtime:${RESET} ${BLUE}${stack.activeRuntime.toUpperCase()}${RESET} · Daemon: ${
          stack.daemonRunning ? `${GREEN}ONLINE${RESET}` : `${ROSE}OFFLINE${RESET}`
        }\n`
      );
      for (const svc of stack.services) {
        const stateColor = svc.state === 'running' ? GREEN : DIM;
        console.log(
          `  ${stateColor}[${svc.state.toUpperCase().padEnd(11)}]${RESET} ${BOLD}${svc.name.padEnd(28)}${RESET} ${BLUE}${svc.webUrl.padEnd(28)}${RESET} ${DIM}(${svc.image})${RESET}`
        );
      }
      return 0;
    }

    if (sub === 'up') {
      const serviceId = args[2];
      const out = await runContainerOrchestrationAction({
        action: serviceId ? 'up' : 'stack-up',
        serviceId,
      });
      console.log(out.output);
      return out.ok ? 0 : 1;
    }

    if (sub === 'down') {
      const out = await runContainerOrchestrationAction({ action: 'stack-down' });
      console.log(out.output);
      return out.ok ? 0 : 1;
    }

    if (sub === 'start-daemon') {
      const out = await runContainerOrchestrationAction({ action: 'start-daemon' });
      console.log(out.output);
      return out.ok ? 0 : 1;
    }
  }

  if (command === 'atlas') {
    const cat = args[1];
    const items =
      cat && cat !== 'all'
        ? CURATED_INDIE_INDEX.filter((i) => i.category === cat)
        : CURATED_INDIE_INDEX;
    if (hasFlag('--json')) {
      console.log(JSON.stringify(items, null, 2));
      return 0;
    }
    printBanner();
    console.log(`\n${BOLD}Real-Web Atlas (${items.length} entries):${RESET}\n`);
    for (const item of items) {
      console.log(
        `  ${BLUE}${item.domain.padEnd(26)}${RESET} [${PURPLE}${item.category}${RESET}] ${BOLD}${item.title}${RESET}`
      );
      console.log(`    ${DIM}${item.description}${RESET}`);
    }
    return 0;
  }

  if (command === 'rules') {
    console.log(exportUBlacklistRuleset(DEFAULT_SLOP_DOMAINS));
    return 0;
  }

  printHelp();
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureNetwork();
  runCli(process.argv).then((code) => process.exit(code));
}
