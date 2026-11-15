# SearXNG with glogg's settings baked in: JSON API on, safe search off, slow engines off.
# Upstream declares VOLUME /etc/searxng, which Docker Compose preserves across image updates;
# SEARXNG_SETTINGS_PATH points outside that volume so updated images always take effect.
# Its secret key comes from SEARXNG_SECRET when that is set.
FROM searxng/searxng:2026.11.8-3a3dd15bf
RUN mkdir -p -m 0755 /etc/searxng-glogg
COPY --chmod=0644 settings.yml /etc/searxng/settings.yml
COPY --chmod=0644 settings.yml /etc/searxng-glogg/settings.yml
ENV SEARXNG_SETTINGS_PATH=/etc/searxng-glogg/settings.yml
