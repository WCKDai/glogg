# Interface direction

Glogg is a search tool. The query, result titles, source addresses and actions should take precedence over slogans or decoration. The existing mug logo and all app icons are retained.

The main interaction reference is [Hacker News](https://news.ycombinator.com/): compact navigation, numbered title-first rows, domains beside titles and secondary actions close to source information. The [Web Design Museum's golden-age collection](https://www.webdesignmuseum.org/golden-age-of-web-design) also informs the conventional controls and links. Use white, neutral gray and blue underlined links; retain the mug's existing color. Dark mode uses neutral charcoal surfaces. Avoid ornamental cards, gradients, oversized promotional headings and simulated CRT effects.

## Type

| Use | Family | Reason |
| --- | --- | --- |
| Wordmark | Trebuchet MS Bold | Its rounded letterforms sit beside the original mug. Microsoft designed it for screens in 1996. |
| Interface and results | Verdana | Open, distinct letterforms make search results easier to scan. It was released in 1996 for screen reading. |
| Short technical labels | Lucida Console / Monaco | Compact monospace text distinguishes timings, keys and addresses. |

These are CSS system-font stacks; no proprietary font files are redistributed and no webfont request is made. Fallbacks cover platforms without the named fonts. The full stacks are defined in `src/client/styles.css`. Do not turn paragraphs or result snippets into pixel lettering.

Primary font references: [Microsoft's Trebuchet MS documentation](https://learn.microsoft.com/en-us/typography/font-list/trebuchet-ms) and [Verdana documentation](https://learn.microsoft.com/en-us/typography/font-list/verdana).

## Interaction

Keep search near the top of the page, with a visible Search action, real navigation links, keyboard operation and a readable focus ring. Result snippets remain readable; the compact preference still reduces them to one line. Phone inputs use at least 16px text; result actions use actual 44px touch targets rather than overlapping invisible hit areas. Scope labels scroll horizontally without shrinking into each other. Saved, source preferences, reader access and export stay available. Public mode hides features the server refuses.

Results expose their source and ranking context. A reference-source or curated-site label is a classification, not verification of a page's truth or an AI detector. Search quality needs maintained ranking fixtures and human review of real queries.

Search focus belongs to the whole field: one inset border, no offset ring around the inner input. Images and Videos use compact grids with source and credit links. Viewers preserve keyboard/focus behavior; video starts only after Play and stops when the viewer closes or navigation leaves it. Freshness labels distinguish when a source was fetched from when an article was published or indexed.

Structural references inspected during the redesign: [Elicit navigation](https://mobbin.com/screens/9e04551b-0577-4bb1-a8c0-8e6fa15a3db0), [Surfshark Search](https://mobbin.com/screens/1ab6c44c-6a86-407f-b41d-08b26ad839de), and [Quartz's article list](https://mobbin.com/screens/f8625bc0-e555-444f-aa28-c90615d275c9). Their layout patterns informed the hierarchy; Glogg's colors and typography follow the early-web direction above.
