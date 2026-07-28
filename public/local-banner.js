(function () {
  fetch('/api/env')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.local) return;
      var b = document.createElement('div');
      b.id = 'local-env-banner';
      b.textContent = 'LOCAL — TEST DATA';
      b.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#dc2626', 'color:#fff', 'text-align:center',
        'font-size:11px', 'font-weight:800', 'letter-spacing:.1em',
        'padding:4px 0', 'pointer-events:none', 'user-select:none',
      ].join(';');
      document.body.appendChild(b);
      // Push page content down so the banner doesn't overlap the top nav
      document.documentElement.style.paddingTop =
        (parseInt(document.documentElement.style.paddingTop) || 0) + 22 + 'px';
    })
    .catch(function () {});
})();
