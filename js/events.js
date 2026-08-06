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

  function cardFull(ev) {
    var href = esc(ev.url || TICKETS_FALLBACK);
    var meta = [ev.date.weekday, ev.date.timeLabel, ev.ageLabel].filter(Boolean).join(' · ');
    return (
      '<div class="show-card">' +
        '<div class="show-media">' +
          (ev.image
            ? '<img class="show-img" src="' + esc(ev.image) + '" alt="' + esc(ev.name) + '" loading="lazy">'
            : '<div class="show-img" style="background:var(--dark)"></div>') +
          '<div class="show-date">' +
            '<span class="show-date-day">' + esc(ev.date.dayLabel) + '</span>' +
            '<span class="show-date-mon">' + esc(ev.date.monthLabel) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="show-body">' +
          '<p class="show-meta">' + esc(meta) + '</p>' +
          '<p class="show-name">' + esc(ev.name) + '</p>' +
          (ev.support ? '<p class="show-support">' + esc(ev.support) + '</p>' : '') +
          (ev.description ? '<p class="show-desc">' + esc(ev.description) + '</p>' : '') +
        '</div>' +
        '<div class="show-foot">' +
          '<span>' + esc(ev.venue || 'SLO Brew Live') + '</span>' +
          '<span class="show-price">' + esc(ev.priceDisplay) + '</span>' +
        '</div>' +
        '<a href="' + href + '" class="show-btn" target="_blank" rel="noopener" ' +
          'aria-label="Get tickets for ' + esc(ev.name) + '">Get Tickets</a>' +
      '</div>'
    );
  }

  /**
   * Full calendar: every show, grouped under a month heading. The headings are
   * real structure — they're how someone scanning a long list finds "what's on
   * in October" — not decoration.
   */
  function renderFull(container, events) {
    var html = '';
    var currentMonth = '';
    events.forEach(function (ev, i) {
      if (ev.date.monthYear !== currentMonth) {
        currentMonth = ev.date.monthYear;
        var count = events.filter(function (e) {
          return e.date.monthYear === currentMonth;
        }).length;
        html +=
          '<div class="show-month">' +
            '<span class="show-month-name">' + esc(currentMonth) + '</span>' +
            '<span class="show-month-count">' + count + (count === 1 ? ' show' : ' shows') + '</span>' +
          '</div>';
      }
      html += cardFull(ev);
    });
    container.innerHTML = html;
  }

  function render(container, events) {
    var limit = parseInt(container.getAttribute('data-limit'), 10);
    var list = limit > 0 ? events.slice(0, limit) : events;
    var variant = container.getAttribute('data-variant') || 'lg';
    var cta = container.getAttribute('data-cta') || '';

    if (variant === 'full') {
      renderFull(container, list);
    } else {
      container.innerHTML = list
        .map(function (ev) {
          return variant === 'sm' ? cardSmall(ev, cta) : cardLarge(ev);
        })
        .join('');
    }

    // Let the page show a live count if it has somewhere to put one.
    var counter = document.querySelector('[data-events-count]');
    if (counter) {
      counter.textContent =
        list.length + (list.length === 1 ? ' upcoming show' : ' upcoming shows');
    }
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
