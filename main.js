(function () {
    'use strict';

    // --- Copyright year, so it never goes stale ---
    var year = document.getElementById('year');
    if (year) year.textContent = new Date().getFullYear();

    // --- Mobile navigation ---
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');

    if (toggle && links) {
        toggle.addEventListener('click', function () {
            var open = links.classList.toggle('open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
        });

        links.addEventListener('click', function (e) {
            if (e.target.tagName === 'A') {
                links.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-label', 'Open navigation menu');
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && links.classList.contains('open')) {
                links.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-label', 'Open navigation menu');
                toggle.focus();
            }
        });
    }

    // --- Contact form validation with visible, announced errors ---
    var form = document.querySelector('.contact-form');
    if (!form) return;

    function validate(field) {
        var err = document.getElementById(field.id + '-error');
        var ok = field.checkValidity() && field.value.trim() !== '';
        if (err) err.hidden = ok;
        field.setAttribute('aria-invalid', ok ? 'false' : 'true');
        return ok;
    }

    var fields = ['name', 'email', 'message']
        .map(function (id) { return document.getElementById(id); })
        .filter(Boolean);

    fields.forEach(function (f) {
        f.addEventListener('blur', function () { validate(f); });
        f.addEventListener('input', function () {
            if (f.getAttribute('aria-invalid') === 'true') validate(f);
        });
    });

    form.addEventListener('submit', function (e) {
        var firstBad = null;
        fields.forEach(function (f) {
            if (!validate(f) && !firstBad) firstBad = f;
        });
        if (firstBad) {
            e.preventDefault();
            firstBad.focus();
        }
    });
})();
