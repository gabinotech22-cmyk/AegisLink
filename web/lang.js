/*
 * lang.js — ES/EN/IT for the landing's sub-pages (privacy, terms, legal,
 * donate, selfhost). Same choice order as index.html, and the same
 * localStorage key, so a language picked on the landing carries over:
 *   ?lang=  →  localStorage 'aegis-lang'  →  navigator.language  →  en
 *
 * Markup contract (each page):
 *   <html lang="en" data-lang="en">        English is what renders without JS
 *   <… data-l="es">…</…>                   one element per language; the page's
 *                                          CSS hides the ones not matching
 *                                          html[data-lang]
 *   <script type="application/json" id="i18n-meta">{"es":{"title":…,"desc":…},…}
 *   <div class="lang-switch"><button data-lang="es">ES</button>…</div>
 *
 * Nothing is fetched and nothing leaves the browser: the choice lives in
 * localStorage only (the nginx vhost has access_log off).
 */
(function () {
  'use strict';
  var LANGS = ['es', 'en', 'it'];
  var root = document.documentElement;
  var meta = {};
  try {
    var m = document.getElementById('i18n-meta');
    if (m) meta = JSON.parse(m.textContent || '{}');
  } catch (e) { /* malformed meta: keep the static title */ }

  function valid(l) { return LANGS.indexOf(l) >= 0; }

  function detect() {
    try {
      var q = new URLSearchParams(location.search).get('lang');
      if (q && valid(q)) return q;
    } catch (e) { /* ignore */ }
    try {
      var saved = localStorage.getItem('aegis-lang');
      if (saved && valid(saved)) return saved;
    } catch (e) { /* private mode */ }
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return valid(nav) ? nav : 'en';
  }

  function apply(l, persist) {
    if (!valid(l)) return;
    root.lang = l;
    root.setAttribute('data-lang', l);
    var md = meta[l];
    if (md) {
      if (md.title) document.title = md.title;
      var desc = document.querySelector('meta[name="description"]');
      if (desc && md.desc) desc.setAttribute('content', md.desc);
    }
    var btns = document.querySelectorAll('.lang-switch button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-lang') === l;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (!persist) return;
    try { localStorage.setItem('aegis-lang', l); } catch (e) { /* ignore */ }
    try {
      var url = new URL(location.href);
      if (url.searchParams.has('lang')) {
        url.searchParams.set('lang', l);
        history.replaceState(null, '', url);
      }
    } catch (e) { /* ignore */ }
  }

  var buttons = document.querySelectorAll('.lang-switch button');
  for (var j = 0; j < buttons.length; j++) {
    buttons[j].addEventListener('click', function (ev) {
      apply(ev.currentTarget.getAttribute('data-lang'), true);
    });
  }
  apply(detect(), false);
})();
