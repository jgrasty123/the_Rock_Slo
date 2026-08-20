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
  var MY805_EVENT = 'https://www.my805tix.com/e/';

  /* Unique per-button ids. ts_modal.js binds by element id, so every button on
     the page needs its own. */
  var modalSeq = 0;
  function nextModalId() {
    modalSeq += 1;
    return 'ts-tickets-' + modalSeq;
  }

  function my805Url(slug) {
    return MY805_EVENT + encodeURIComponent(slug) + '/tickets';
  }

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
    var cta = ticketCta(ev);
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
        ticketControl(cta, 'ecl-btn', cta.label + ' for ' + ev.name) +
      '</div>'
    );
  }

  function cardSmall(ev, ctaHref) {
    var base = ticketCta(ev);
    var href = ctaHref || base.href;
    var external = ctaHref ? false : base.external;
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
        ticketControl(
          ctaHref ? { href: href, label: 'Get Tickets', external: false } : base,
          'ec-btn',
          (ctaHref ? 'Get Tickets' : base.label) + ' for ' + ev.name
        ) +
      '</div>'
    );
  }

  /**
   * Manually-added shows may not have a ticket link yet (they aren't sold
   * through TicketWeb). Sending those to the TicketWeb venue page would be a
   * dead end, so they get a "More Info" button pointing at the contact page
   * instead of a "Get Tickets" button that lies.
   */
  function ticketCta(ev) {
    // A My805Tix slug wins: it's the only source that can sell in a modal
    // without leaving the site.
    if (ev.ticketSlug) {
      return { modal: true, slug: ev.ticketSlug, href: my805Url(ev.ticketSlug), label: 'Get Tickets' };
    }
    if (ev.url) return { href: ev.url, label: 'Get Tickets', external: true };
    if (ev.status === 'manual') return { href: 'contact.html', label: 'More Info', external: false };
    return { href: TICKETS_FALLBACK, label: 'Get Tickets', external: true };
  }

  /**
   * The ticket control. Modal shows render a <button> rather than an <a>:
   * ts_modal.js attaches a document-level click listener and does NOT call
   * preventDefault, so an anchor would open the modal AND navigate away.
   * The real destination is kept in data-ts-url so the button still works if
   * the script never loads.
   */
  function ticketControl(cta, cls, ariaLabel) {
    var aria = ariaLabel ? ' aria-label="' + esc(ariaLabel) + '"' : '';
    if (cta.modal) {
      return '<button type="button" id="' + nextModalId() + '" class="' + cls + ' is-modal"' +
        ' data-ts-url="' + esc(cta.href) + '"' + aria + '>' + cta.label + '</button>';
    }
    return '<a href="' + esc(cta.href) + '" class="' + cls + '"' +
      (cta.external ? ' target="_blank" rel="noopener"' : '') + aria + '>' + cta.label + '</a>';
  }

  /**
   * Bind after the cards are in the DOM — ts_modal.js only retries once on
   * DOMContentLoaded, which has already fired by the time our fetch resolves.
   */
  function bindTicketModals(container) {
    var btns = container.querySelectorAll('button[data-ts-url]');
    Array.prototype.forEach.call(btns, function (btn) {
      var url = btn.getAttribute('data-ts-url');
      if (window.TSModals && typeof window.TSModals.buildModal === 'function') {
        window.TSModals.buildModal({ url: url, modalTriggerElementId: btn.id });
      } else {
        // Script blocked or failed: degrade to opening the ticket page.
        btn.addEventListener('click', function () {
          window.open(url, '_blank', 'noopener');
        });
      }
    });
  }

  function cardFull(ev) {
    var cta = ticketCta(ev);
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
        ticketControl(cta, 'show-btn', cta.label + ' for ' + ev.name) +
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

    bindTicketModals(container);

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
