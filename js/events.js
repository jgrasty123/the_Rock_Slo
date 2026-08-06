/**
 * The Rock SLO — live events rendering
 *
 * Reads the normalized feed from /.netlify/functions/events and renders it into
 * any container on the page carrying [data-events].
 *
 * Usage:
 *   <div class="events-grid" data-events data-variant="lg"></div>
 *   <div class="events-row"  data-events data-variant="sm" data-limit="4"></div>
 *
 *   data-variant  "lg" (events page cards) or "sm" (homepage cards)
 *   data-limit    optional max number of events to show
 *   data-cta      optional href override for the button; defaults to the
 *                 TicketWeb purchase link for that event
 *
 * If the feed fails or returns nothing, the container's existing markup is left
 * untouched — so whatever fallback is already in the HTML stays visible.
 */
(function () {
  'use strict';

  var ENDPOINT = '/.netlify/functions/events';
  var TICKETS_FALLBACK = 'https://www.ticketweb.com/venue/slo-brew-rock-san-luis-obispo-ca/428495';

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** "Aug 29 · 7:00 PM · All Ages" — omitting any part the feed didn't supply. */
  function metaLine(ev) {
    return [ev.date.dateLabel, ev.date.timeLabel, ev.ageLabel]
      .filter(Boolean)
      .join(' · ');
  }

  function cardLarge(ev) {
    var href = esc(ev.url || TICKETS_FALLBACK);
    return (
      '<div class="event-card-lg">' +
        (ev.image
          ? '<img class="ecl-img" src="' + esc(ev.image) + '" alt="' + esc(ev.name) + '" loading="lazy">'
          : '<div class="ecl-img" style="background:var(--dark)"></div>') +
        '<div class="ecl-body">' +
          '<p class="ecl-date">' + esc(metaLine(ev)) + '</p>' +
          '<p class="ecl-name">' + esc(ev.name) + '</p>' +
          '<p class="ecl-support">' + (ev.support ? esc(ev.support) : '&nbsp;') + '</p>' +
        '</div>' +
        '<div class="ecl-foot">' +
          '<span>' + esc(ev.venue || 'SLO Brew Live') + '</span>' +
          '<span class="ecl-price">' + esc(ev.priceDisplay) + '</span>' +
        '</div>' +
        '<a href="' + href + '" class="ecl-btn" target="_blank" rel="noopener">Get Tickets</a>' +
      '</div>'
    );
  }

  function cardSmall(ev, ctaHref) {
    var href = esc(ctaHref || ev.url || TICKETS_FALLBACK);
    var external = !ctaHref;
    return (
      '<div class="event-card">' +
        (ev.image
          ? '<img class="ec-img" src="' + esc(ev.image) + '" alt="' + esc(ev.name) + '" loading="lazy">'
          : '<div class="ec-img" style="background:var(--dark)"></div>') +
        '<div class="ec-body">' +
          '<p class="ec-date">' + esc(metaLine(ev)) + '</p>' +
          '<p class="ec-name">' + esc(ev.name) + '</p>' +
          '<p class="ec-support">' + (ev.support ? esc(ev.support) : '&nbsp;') + '</p>' +
        '</div>' +
        '<div class="ec-foot">' +
          '<span>' + esc(ev.venue || 'SLO Brew Live') + '</span>' +
          '<span class="ec-price">' + esc(ev.priceDisplay) + '</span>' +
        '</div>' +
        '<a href="' + href + '" class="ec-btn"' +
          (external ? ' target="_blank" rel="noopener"' : '') +
        '>Get Tickets</a>' +
      '</div>'
    );
  }

  function render(container, events) {
    var limit = parseInt(container.getAttribute('data-limit'), 10);
    var list = limit > 0 ? events.slice(0, limit) : events;
    var variant = container.getAttribute('data-variant') || 'lg';
    var cta = container.getAttribute('data-cta') || '';

    container.innerHTML = list
      .map(function (ev) {
        return variant === 'sm' ? cardSmall(ev, cta) : cardLarge(ev);
      })
      .join('');
    container.removeAttribute('data-loading');
  }

  function init() {
    var containers = document.querySelectorAll('[data-events]');
    if (!containers.length) return;

    fetch(ENDPOINT)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok || !data.events || !data.events.length) return;
        Array.prototype.forEach.call(containers, function (c) {
          render(c, data.events);
        });
      })
      .catch(function () {
        /* Leave the in-page fallback markup as-is. */
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
