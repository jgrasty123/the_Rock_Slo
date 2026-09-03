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
  /* Rendered events, so an info button can find its event and the ticket
     trigger that's already bound to the checkout modal. */
  var registry = [];
  var modalSeq = 0;
  function nextModalId() {
    modalSeq += 1;
    return 'ts-tickets-' + modalSeq;
  }

  function my805Url(slug) {
    return MY805_EVENT + encodeURIComponent(slug) + '/tickets';
  }

  /* The event page renders without My805Tix's site chrome when asked for the
     modal view — without it the frame drags in their whole nav bar. */
  function my805InfoUrl(slug) {
    return MY805_EVENT + encodeURIComponent(slug);
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
        ctaRow(ev, 'ecl-btn', 'ecl-btn-alt') +
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
        (ctaHref
          ? ticketControl({ href: href, label: 'Get Tickets', external: false },
              'ec-btn', 'Get Tickets for ' + ev.name)
          : ctaRow(ev, 'ec-btn', 'ec-btn-alt')) +
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
    if (ev.soldOut) {
      return { soldOut: true, label: 'Sold Out' };
    }
    // A slug means the show sells on My805Tix, which is the only case the
    // modal can handle without leaving the site.
    if (ev.ticketSlug) {
      return { modal: true, slug: ev.ticketSlug, href: my805Url(ev.ticketSlug), label: 'Get Tickets' };
    }
    // Listing-only events sell somewhere else (TicketWeb, a promoter's site).
    if (ev.externalTicketUrl) {
      return { href: ev.externalTicketUrl, label: 'Get Tickets', external: true };
    }
    if (ev.url) return { href: ev.url, label: 'Get Tickets', external: true };
    return { href: TICKETS_FALLBACK, label: 'Get Tickets', external: true };
  }

  /**
   * Secondary button — the full event details. When the show lives on
   * My805Tix its page opens in the same modal as the checkout, so nobody
   * leaves the site. Listing-only events have no My805Tix page worth
   * framing, so those fall back to a plain link.
   */
  function infoCta(ev) {
    // Their ?modal=true view clips long descriptions — .ts-modal-content is
    // overflow:hidden and event copy runs well past its height, with no way to
    // scroll and no way for us to fix it inside a cross-origin frame. The feed
    // already carries the description, so render it ourselves instead.
    if (ev.descriptionHtml || ev.description) {
      return { own: true, label: 'More Info' };
    }
    if (!ev.url) return null;
    return { href: ev.url, label: 'More Info', external: true };
  }

  /**
   * The ticket control. Modal shows render a <button> rather than an <a>:
   * ts_modal.js attaches a document-level click listener and does NOT call
   * preventDefault, so an anchor would open the modal AND navigate away.
   * The real destination is kept in data-ts-url so the button still works if
   * the script never loads.
   */
  function ticketControl(cta, cls, ariaLabel, forcedId) {
    var aria = ariaLabel ? ' aria-label="' + esc(ariaLabel) + '"' : '';
    if (cta.soldOut) {
      return '<span class="' + cls + ' is-soldout" aria-disabled="true">' + cta.label + '</span>';
    }
    if (cta.modal) {
      return '<button type="button" id="' + (forcedId || nextModalId()) + '" class="' + cls + ' is-modal"' +
        ' data-ts-url="' + esc(cta.href) + '"' + aria + '>' + cta.label + '</button>';
    }
    return '<a href="' + esc(cta.href) + '" class="' + cls + '"' +
      (cta.external ? ' target="_blank" rel="noopener"' : '') + aria + '>' + cta.label + '</a>';
  }


  /* ------------------------------------------------ event details modal ---
     Ours, not theirs: their framed view can't scroll long descriptions. This
     one owns its scroll, matches the site, traps focus and restores it. */

  var infoEl = null;
  var lastFocus = null;

  function buildInfoModal() {
    if (infoEl) return infoEl;
    infoEl = document.createElement('div');
    infoEl.className = 'ev-modal';
    infoEl.setAttribute('hidden', '');
    infoEl.innerHTML =
      '<div class="ev-modal-backdrop" data-close></div>' +
      '<div class="ev-modal-panel" role="dialog" aria-modal="true" aria-labelledby="ev-modal-title">' +
        '<button type="button" class="ev-modal-close" data-close aria-label="Close">&times;</button>' +
        '<div class="ev-modal-scroll">' +
          '<div class="ev-modal-head">' +
            '<p class="ev-modal-meta"></p>' +
            '<h2 class="ev-modal-title" id="ev-modal-title"></h2>' +
            '<p class="ev-modal-support"></p>' +
          '</div>' +
          '<div class="ev-modal-body"></div>' +
        '</div>' +
        '<div class="ev-modal-foot"></div>' +
      '</div>';
    document.body.appendChild(infoEl);

    infoEl.addEventListener('click', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-close')) closeInfoModal();
    });
    return infoEl;
  }

  function closeInfoModal() {
    if (!infoEl || infoEl.hasAttribute('hidden')) return;
    infoEl.setAttribute('hidden', '');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onInfoKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function onInfoKey(e) {
    if (e.key === 'Escape') { closeInfoModal(); return; }
    if (e.key !== 'Tab' || !infoEl) return;
    var f = infoEl.querySelectorAll('button, [href], .ev-modal-scroll');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openInfoModal(entry) {
    var ev = entry.ev;
    var el = buildInfoModal();
    lastFocus = document.activeElement;

    var bits = [ev.date.weekday + ' · ' + ev.date.dateLabel + ', ' + ev.date.yearLabel];
    if (ev.date.timeLabel) bits.push(ev.date.timeLabel);
    if (ev.venue) bits.push(ev.venue);
    if (ev.ageLabel) bits.push(ev.ageLabel);

    el.querySelector('.ev-modal-meta').textContent = bits.join(' · ');
    el.querySelector('.ev-modal-title').textContent = ev.name;

    var sup = el.querySelector('.ev-modal-support');
    sup.textContent = ev.support || '';
    sup.style.display = ev.support ? '' : 'none';

    // Sanitized server-side; falls back to plain text if it's ever empty.
    var body = el.querySelector('.ev-modal-body');
    if (ev.descriptionHtml) body.innerHTML = ev.descriptionHtml;
    else body.textContent = ev.description || '';

    // Reuse the card's own ticket trigger so the checkout binding still holds.
    var foot = el.querySelector('.ev-modal-foot');
    foot.innerHTML = '';
    if (ev.priceDisplay) {
      var price = document.createElement('span');
      price.className = 'ev-modal-price';
      price.textContent = ev.priceDisplay;
      foot.appendChild(price);
    }
    if (ev.soldOut) {
      var so = document.createElement('span');
      so.className = 'show-btn is-soldout';
      so.textContent = 'Sold Out';
      foot.appendChild(so);
    } else if (entry.ticketId && document.getElementById(entry.ticketId)) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'show-btn is-modal';
      btn.textContent = 'Get Tickets';
      btn.addEventListener('click', function () {
        var trigger = document.getElementById(entry.ticketId);
        closeInfoModal();
        if (trigger) trigger.click();
      });
      foot.appendChild(btn);
    } else if (ev.externalTicketUrl || ev.url) {
      var a = document.createElement('a');
      a.className = 'show-btn';
      a.href = ev.externalTicketUrl || ev.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Get Tickets';
      foot.appendChild(a);
    }

    el.querySelector('.ev-modal-scroll').scrollTop = 0;
    el.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onInfoKey);
    el.querySelector('.ev-modal-close').focus();
  }

  /**
   * Brand the parts of the My805Tix modal that live in OUR document.
   *
   * The checkout itself is a cross-origin iframe on my805tix.com — its
   * layout, colours and the quantity control are theirs and cannot be
   * touched from here. What we do own: the backdrop behind the iframe
   * (their page is transparent, so ours shows through), the loading
   * spinner, and the button labels they accept as URL params.
   */
  var modalBranded = false;
  function brandTicketModal() {
    if (modalBranded) return;
    modalBranded = true;

    // Warm near-black instead of flat rgba(0,0,0,.8) — matches --dark.
    window.tsOverlayBackground = 'rgba(28, 20, 16, 0.92)';

    // Their spinner is hardcoded #3397E1 via an @keyframes block appended to
    // <body> at build time. Redefining the same keyframes later in the
    // document wins, so this style tag has to be appended after theirs.
    var s = document.createElement('style');
    s.textContent =
      '@keyframes animate2{' +
        '0%{box-shadow:inset #E07820 0 0 0 17px;transform:rotate(-140deg)}' +
        '50%{box-shadow:inset #E07820 0 0 0 2px}' +
        '100%{box-shadow:inset #E07820 0 0 0 17px;transform:rotate(140deg)}' +
      '}' +
      '#ts-modal-overlay{backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}';
    document.body.appendChild(s);
  }

  /* Note: the modal's button label params (c/cm/n/nm/b/bm) ADD a button
     rather than relabelling the existing one — passing them leaves two
     near-identical CTAs side by side. Left alone deliberately. */

  /**
   * Ticket + info buttons as one row. "More Info" is dropped when there's no
   * event page to point at, so the primary button spans the row on its own.
   */
  function ctaRow(ev, cls, infoCls) {
    var cta = ticketCta(ev);
    var info = infoCta(ev);
    var ticketId = cta.modal ? nextModalId() : '';
    var primary = ticketControl(cta, cls, cta.label + ' for ' + ev.name, ticketId);
    if (!info) return primary;

    var aria = ' aria-label="More info about ' + esc(ev.name) + '"';
    var secondary;
    if (info.own) {
      var idx = registry.push({ ev: ev, ticketId: ticketId }) - 1;
      secondary = '<button type="button" class="' + infoCls + ' is-modal"' +
        ' data-info-index="' + idx + '"' + aria + '>' + info.label + '</button>';
    } else {
      secondary = '<a href="' + esc(info.href) + '" class="' + infoCls + '"' +
        ' target="_blank" rel="noopener"' + aria + '>' + info.label + '</a>';
    }
    return '<div class="cta-row">' + primary + secondary + '</div>';
  }

  /**
   * Bind after the cards are in the DOM — ts_modal.js only retries once on
   * DOMContentLoaded, which has already fired by the time our fetch resolves.
   */
  function bindTicketModals(container) {
    // Our own details modal.
    var infoBtns = container.querySelectorAll('button[data-info-index]');
    Array.prototype.forEach.call(infoBtns, function (btn) {
      btn.addEventListener('click', function () {
        var entry = registry[+btn.getAttribute('data-info-index')];
        if (entry) openInfoModal(entry);
      });
    });

    var btns = container.querySelectorAll('button[data-ts-url]');
    Array.prototype.forEach.call(btns, function (btn) {
      var url = btn.getAttribute('data-ts-url');
      if (window.TSModals && typeof window.TSModals.buildModal === 'function') {
        window.TSModals.buildModal({ url: url, modalTriggerElementId: btn.id });
        brandTicketModal();
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
        ctaRow(ev, 'show-btn', 'show-btn-alt') +
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
