export interface InspectorPreset {
  id: string;
  label: string;
  url: string;
  rawHtml?: string;
}

export const INSPECTOR_PRESETS: InspectorPreset[] = [
  {
    id: 'live-danluu',
    label: 'Live: danluu.com (Indie Systems)',
    url: 'https://danluu.com/',
  },
  {
    id: 'live-based-cooking',
    label: 'Live: based.cooking (Zero-Fluff)',
    url: 'https://based.cooking/',
  },
  {
    id: 'sample-seo-slop',
    label: 'Autopsy Demo: SEO Affiliate Slop vs Primary Citations',
    url: 'https://techradar-reviews-example.com/15-best-nvme-ssds-ultimate-guide-2026?utm_source=google&gclid=998877',
    rawHtml: `<!doctype html>
<html>
<head>
  <title>15 Best NVMe SSDs in 2026: The Ultimate Guide to Everything You Need to Know</title>
  <script src="https://www.googletagmanager.com/gtm.js"></script>
  <script src="https://www.google-analytics.com/analytics.js"></script>
  <script src="https://cdn.taboola.com/libtrc/loader.js"></script>
  <script src="https://static.hotjar.com/c/hotjar.js"></script>
  <script src="https://scripts.mediavine.com/tags/slop.js"></script>
</head>
<body>
  <div class="cookie-banner">We and our 847 partners use cookies to personalize ads.</div>
  <div class="newsletter-popup">Subscribe to our Daily Deals Newsletter!</div>
  <aside class="sponsored-widget">Sponsored by EnterpriseStorageCloud</aside>
  <article class="post-content">
    <h1>15 Best NVMe SSDs in 2026: The Ultimate Guide (2026 Updated)</h1>
    <p>In today's fast-paced digital world, storage is a game-changer in the world of computing. Whether you're a seasoned pro or a beginner, choosing a drive can feel like navigating the complexities of modern hardware. Without further ado, let's dive right in!</p>
    <p>We may earn a commission when you buy through affiliate links on our page. Before we dive into the benchmarks, it is important to remember that solid state drives stand as a testament to silicon engineering.</p>
    <h2>1. Affiliate Pick Links (Disarmed by Glogg)</h2>
    <p>Check out our top sponsored pick on <a href="https://amzn.to/3xyzAffiliate?tag=slopmill-20&utm_campaign=ssd2026">Buy Now on Amazon (Best Overall Pick)</a> or compare deals via <a href="https://howl.me/cl998822?utm_source=partner">BestBuy Partner Offer</a>.</p>
    <h2>2. Actual Primary Benchmarks & Thermal Throttling Data</h2>
    <p>Specifically, PCIe 4.0 x4 controllers sustain 7,100 MB/s sequential reads only while SLC cache remains unsaturated; once TLC direct-to-die writes begin after 140 GB, throughput drops to 1,450 MB/s at 72°C controller junction temperature.</p>
    <pre>fio --name=randwrite --ioengine=io_uring --iodepth=32 --rw=randwrite --bs=4k --direct=1 --size=16G</pre>
    <p>For the underlying NVMe 2.0 queueing specification and kernel io_uring polling overhead, refer directly to the primary publications:</p>
    <ul>
      <li><a href="https://arxiv.org/abs/2302.01234">arXiv: Latency Characterization of NVMe over Fabrics and io_uring</a></li>
      <li><a href="https://datatracker.ietf.org/doc/html/rfc9000">IETF RFC 9000 Transport Protocol Specification</a></li>
      <li><a href="https://github.com/axboe/fio">axboe/fio — Flexible I/O Tester Primary Source Repository</a></li>
      <li><a href="https://cs.stanford.edu/~storage/nvme-wear-leveling.pdf">Stanford Storage Lab: NAND Flash Wear-Leveling Empirical Dataset (PDF)</a></li>
    </ul>
  </article>
</body>
</html>`,
  },
];
