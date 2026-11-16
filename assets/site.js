(function () {
  "use strict";
  var CONFIG = window.OP_CONFIG || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  };
  var euro = function (n) { return Math.round(n).toLocaleString("en-GB") + " €"; };
  var LICENCES = {
    small: { name: "Small business", price: 1200, who: "Revenue under 250,000 € in the last fiscal year" },
    business: { name: "Business", price: 4800, who: "Revenue between 250,000 € and 5 M€ in the last fiscal year" },
    enterprise: { name: "Enterprise", price: 12000, who: "Revenue over 5 M€" }
  };

  /* Menu */
  var menu = $(".menu-btn"), nav = $(".nav");
  if (menu && nav) {
    menu.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      menu.setAttribute("aria-expanded", String(open));
      menu.textContent = open ? "Close" : "Menu";
    });
  }

  /* Configured address */
  $$("[data-email]").forEach(function (el) {
    el.textContent = CONFIG.email || "";
    if (el.tagName === "A" && CONFIG.email) el.href = "mailto:" + CONFIG.email;
  });
  $$("[data-email-block]").forEach(function (el) { el.hidden = !CONFIG.email; });

  /* Sends a form through Web3Forms; calls done() on success, shows the error otherwise. */
  var send = function (form, fields, done) {
    var btn = $("button[type=submit]", form), err = $(".form-error", form), label = btn.textContent;
    var fail = function (msg) {
      btn.disabled = false; btn.textContent = label;
      err.textContent = msg + (CONFIG.email ? " You can also write to " + CONFIG.email + "." : "");
      err.hidden = false;
    };
    if (!CONFIG.web3forms) { fail("The form is not configured yet."); return; }
    if (form.botcheck && form.botcheck.checked) { done(); return; }
    err.hidden = true; btn.disabled = true; btn.textContent = "Sending\u2026";
    fields.access_key = CONFIG.web3forms;
    fields.botcheck = false;
    fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(fields)
    }).then(function (r) { return r.json().catch(function () { return { success: false }; }); })
      .then(function (res) {
        if (res && res.success) done();
        else fail("The message could not be sent" + (res && res.message ? " (" + res.message + ")" : "") + ". Please try again in a minute.");
      }, function () { fail("The message could not be sent: the network did not answer. Check your connection and try again."); });
  };
  var reveal = function (form, box) { box.hidden = false; form.hidden = true; box.focus(); };

  /* Copy buttons */
  $$(".code").forEach(function (block) {
    var pre = $("pre", block);
    if (!pre || block.hasAttribute("data-nocopy")) return;
    var btn = document.createElement("button");
    btn.className = "copy"; btn.type = "button"; btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var clone = pre.cloneNode(true);
      $$(".p, .c", clone).forEach(function (n) { n.remove(); });
      var text = clone.textContent.replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); };
      var fallback = function () {
        var range = document.createRange(); range.selectNodeContents(pre);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        btn.textContent = "Selected";
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
    block.appendChild(btn);
  });

  /* Tabs */
  $$("[data-tabs]").forEach(function (box) {
    var buttons = $$(".tablist button", box);
    var show = function (name) {
      buttons.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
      $$("[data-panel]", box).forEach(function (p) { p.hidden = p.dataset.panel !== name; });
      if (box.dataset.tabs) store.set("tabs:" + box.dataset.tabs, name);
    };
    buttons.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.tab); }); });
    var saved = box.dataset.tabs ? store.get("tabs:" + box.dataset.tabs) : null;
    show(saved && buttons.some(function (b) { return b.dataset.tab === saved; }) ? saved : buttons[0].dataset.tab);
  });

  /* The demo sheet */
  var stage = $("#stage");
  if (stage && window.OP_DEMO) {
    var demo = window.OP_DEMO, mode = "read", raf = null;
    var audio = new Audio(); audio.preload = "none";
    var canvas = $("canvas", stage), said = $(".said-row", stage), playBtn = $(".play", stage);
    var css = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };
    var playIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>';
    var pauseIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h3.5v14H5zM11.5 3H15v14h-3.5z" fill="currentColor"/></svg>';

    var draw = function (t) {
      var d = demo[mode], dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w) return;
      canvas.width = w * dpr; canvas.height = h * dpr;
      var ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
      var n = d.peaks.length, gap = n > 150 ? 1 : 2, bw = Math.max(1, (w - gap * (n - 1)) / n);
      var off = css("--wave"), on = css("--ink"), red = css("--red");
      for (var i = 0; i < n; i++) {
        var time = (i + 0.5) / n * d.duration;
        var bad = d.words.some(function (x) { return x.bad && time >= x.s - 0.03 && time <= x.e + 0.03; });
        var bh = Math.max(2, d.peaks[i] * (h - 4));
        ctx.fillStyle = bad ? red : (time <= t ? on : off);
        ctx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
      }
    };

    var renderWords = function () {
      var d = demo[mode], html = "", seg = 0;
      var words = mode === "read" ? d.expected.replace(/[,.]/g, "").split(" ") : null;
      d.words.forEach(function (w, i) {
        if (mode === "free" && d.segments[seg + 1] && w.s >= d.segments[seg + 1].s) { seg++; html += '<span class="seg-mark" aria-hidden="true">/</span> '; }
        var label = words ? words[i] : w.w, cls = "word", pen = "";
        if (w.bad) cls += " bad";
        if (w.missing) { cls += " missing"; pen = '<span class="pen">not said</span>'; }
        else if (w.bad && w.heard) pen = '<span class="pen ipa">/' + w.heard + "/</span>";
        html += '<span class="' + cls + '" data-i="' + i + '">' + label + pen + "</span> ";
      });
      said.innerHTML = html;
    };

    var renderResult = function () {
      var d = demo[mode];
      $(".big-score", stage).innerHTML = Math.round(d.scores.total) + "<small>/100</small>";
      var dims = $$(".dim b", stage);
      dims[0].textContent = d.scores.accuracy.toFixed(1);
      dims[1].textContent = d.scores.fluency.toFixed(1);
      dims[2].textContent = d.scores.prosodic.toFixed(1);
      var notes = "";
      if (mode === "read") {
        notes += "<p>The sentence to read was “" + d.expected + "”. The speaker said “developer” instead of “good designer”.</p>";
        d.words.filter(function (w) { return w.bad && !w.missing; }).forEach(function (w) {
          notes += '<p><em>' + w.w + '</em>: expected <span class="ipa">/' + w.expected + '/</span>, heard <span class="ipa red">/' + w.heard + "/</span>.</p>";
        });
        notes += "<p>A word was not said, so the result is marked <code>reliable: false</code>.</p>";
      } else {
        notes += "<p>No text was given. The recording was transcribed and cut into " + d.segments.length + " parts at its pauses, scored " + d.segments.map(function (s) { return Math.round(s.total); }).join(", ") + ".</p>";
        var unclear = d.words.filter(function (w) { return w.bad; }).length;
        notes += "<p>" + (unclear ? unclear + " words came out unclear." : "No word came out unclear.") + " The result is marked <code>reliable: true</code>.</p>";
      }
      $(".notes", stage).innerHTML = notes;
      $(".stage-label", stage).textContent = (mode === "read" ? "developer.wav" : "harvard.wav") + ", " + d.duration.toFixed(1) + " s";
    };

    var tick = function () {
      var d = demo[mode], t = audio.currentTime;
      draw(t);
      $$(".word", said).forEach(function (el) {
        var w = d.words[+el.dataset.i];
        el.classList.toggle("now", t >= w.s && t <= w.e + 0.08);
      });
      if (!audio.paused) raf = requestAnimationFrame(tick);
    };
    var stop = function () {
      cancelAnimationFrame(raf);
      playBtn.innerHTML = playIcon; playBtn.setAttribute("aria-label", "Play the recording");
      $$(".word", said).forEach(function (el) { el.classList.remove("now"); });
      draw(-1);
    };
    audio.addEventListener("ended", stop);
    audio.addEventListener("pause", function () { cancelAnimationFrame(raf); playBtn.innerHTML = playIcon; });
    playBtn.addEventListener("click", function () {
      if (audio.dataset.mode !== mode) { audio.src = demo[mode].audio; audio.dataset.mode = mode; }
      if (audio.paused) {
        if (audio.ended || audio.currentTime >= demo[mode].duration - 0.05) audio.currentTime = 0;
        audio.play().then(function () {
          playBtn.innerHTML = pauseIcon; playBtn.setAttribute("aria-label", "Pause");
          raf = requestAnimationFrame(tick);
        }, stop);
      } else audio.pause();
    });
    $(".wave", stage).addEventListener("click", function (e) {
      if (audio.dataset.mode !== mode) return;
      var r = canvas.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * demo[mode].duration;
      tick();
    });
    var setMode = function (m) {
      mode = m;
      audio.pause(); audio.removeAttribute("src"); delete audio.dataset.mode;
      $$(".seg button", stage).forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.mode === m)); });
      renderWords(); renderResult(); stop();
    };
    $$(".seg button", stage).forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.mode); }); });
    window.addEventListener("resize", function () { draw(audio.paused ? -1 : audio.currentTime); });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { draw(-1); });
    setMode("read");
  }

  /* Licence chooser (pricing) */
  var chooser = $("#chooser");
  if (chooser) {
    var answers = {
      oss: { title: "The AGPL, free of charge.", text: "Testing it, measuring it on your recordings and building an open-source product are all covered by the AGPL. Nothing to buy.", cta: "Installation guide", href: "developers.html" },
      small: { title: "Small business, 1,200 € a year.", text: "For one closed product, in a company whose revenue was under 250,000 € last year.", cta: "Order", href: "buy.html#small" },
      business: { title: "Business, 4,800 € a year.", text: "For one closed product, in a company whose revenue was between 250,000 € and 5 M€ last year.", cta: "Order", href: "buy.html#business" },
      enterprise: { title: "Enterprise, from 12,000 € a year.", text: "Over 5 M€ of revenue, or several products. The price depends on what you ship; ask for a quote.", cta: "Ask for a quote", href: "contact.html#enterprise" }
    };
    var update = function () {
      var use = (chooser.querySelector("input[name=use]:checked") || {}).value;
      var size = (chooser.querySelector("input[name=size]:checked") || {}).value || "small";
      $("#q-size").hidden = use !== "closed";
      var key = use === "closed" ? size : "oss", a = answers[key], box = $("#verdict");
      $("h3", box).textContent = a.title;
      $("p", box).textContent = a.text;
      var link = $("a", box); link.textContent = a.cta; link.href = a.href;
      $$(".plan").forEach(function (el) { el.classList.toggle("pick", el.dataset.plan === key); });
    };
    chooser.addEventListener("change", update);
    update();
  }

  /* Cost calculator (teams) */
  var calc = $("#calc");
  if (calc) {
    var run = function () {
      var n = function (id) { var v = parseFloat($("#" + id).value); return isFinite(v) && v > 0 ? v : 0; };
      var perDay = n("c-rec"), secs = n("c-sec"), price = n("c-price"), server = n("c-server"), tier = $("#c-tier").value;
      var hoursDay = perDay * secs / 3600, hoursYear = hoursDay * 365;
      var servers = Math.max(1, Math.ceil(hoursDay / 48));
      var cloud = hoursYear * price, own = servers * server * 12 + LICENCES[tier].price;
      $("#o-cloud").textContent = euro(cloud);
      $("#o-own").textContent = euro(own);
      $("#o-hours").textContent = Math.round(hoursYear).toLocaleString("en-GB") + " hours of audio a year";
      $("#o-servers").textContent = servers + (servers > 1 ? " servers" : " server") + " and the " + LICENCES[tier].name + " licence";
      var diff = cloud - own, out = $("#o-verdict");
      var breakEven = Math.ceil(own / Math.max(price, 0.01) * 3600 / 365 / Math.max(secs, 1));
      out.textContent = diff > 0
        ? "Running it yourself costs " + euro(diff) + " less a year at this volume."
        : "At this volume the cloud API is cheaper by " + euro(-diff) + " a year. Self-hosting breaks even around " + breakEven.toLocaleString("en-GB") + " recordings a day, unless keeping the recordings in-house is a requirement on its own.";
    };
    calc.addEventListener("input", run);
    calc.addEventListener("submit", function (e) { e.preventDefault(); });
    run();
  }

  /* Agreement reader */
  $$("[data-reader]").forEach(function (box) {
    var input = $("input", box), out = $(".reader-out", box);
    var read = function () {
      var r = parseFloat(String(input.value).replace(",", "."));
      if (!isFinite(r) || r < -1 || r > 1) { out.textContent = "Type the Pearson value from the report, between 0 and 1."; return; }
      if (r >= 0.8) out.textContent = "The score agrees with your assessors about as well as it agrees with the benchmark raters on adults reading. It can be shown to your users.";
      else if (r >= 0.65) out.textContent = "Good enough to rank speakers and follow changes over time. Show it as a band (good, fair, needs work) rather than an exact number.";
      else if (r >= 0.5) out.textContent = "A single score is noisy at this level. Use the average of several recordings, for placement or progress reports.";
      else out.textContent = "Not ready to show to your users. Your recordings probably differ from what the models learned, in age, task or audio. Send the report through the contact page: it will be read and answered.";
    };
    input.addEventListener("input", read);
    read();
  });

  /* Onboarding progress */
  var steps = $$(".step[data-step]");
  if (steps.length) {
    var bar = $(".progress .track i"), label = $(".progress .count");
    var refresh = function () {
      var done = steps.filter(function (s) { return s.classList.contains("done"); }).length;
      if (bar) bar.style.width = (done / steps.length * 100) + "%";
      if (label) label.textContent = done + " of " + steps.length + " steps done";
    };
    steps.forEach(function (s) {
      var key = "step:" + s.dataset.step, btn = $(".done-btn", s);
      if (store.get(key) === "1") s.classList.add("done");
      if (!btn) return;
      var sync = function () { btn.textContent = s.classList.contains("done") ? "Done" : "Mark as done"; };
      sync();
      btn.addEventListener("click", function () {
        s.classList.toggle("done");
        store.set(key, s.classList.contains("done") ? "1" : "0");
        sync(); refresh();
      });
    });
    refresh();
  }

  /* Order form */
  var order = $("#order");
  if (order) {
    var current = function () { var h = (location.hash || "").slice(1); return h === "small" || h === "business" ? h : order.plan.value; };
    var paint = function () {
      var key = current(), p = LICENCES[key];
      order.plan.value = key;
      $("#sum-name").textContent = p.name + " licence";
      $("#sum-who").textContent = p.who;
      $("#sum-price").textContent = euro(p.price);
      $$("input[name=plan-pick]").forEach(function (i) { i.checked = i.value === key; });
    };
    $$("input[name=plan-pick]").forEach(function (i) {
      i.addEventListener("change", function () { if (history.replaceState) history.replaceState(null, "", "#" + i.value); paint(); });
    });
    window.addEventListener("hashchange", paint);
    paint();
    order.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!order.reportValidity()) return;
      var key = current(), p = LICENCES[key], url = (CONFIG.checkout || {})[key];
      if (url) { window.location.href = url; return; }
      var body = ["Licence: " + p.name + " (" + euro(p.price) + " per year)", "Company: " + order.company.value, "Country: " + order.country.value,
        "Product: " + order.product.value, "Billing email: " + order.billing.value, "Declared: " + p.who].join("\n");
      send(order, {
        subject: "OpenPronounce order: " + p.name + " licence, " + order.company.value,
        from_name: "openpronounce.github.io",
        email: order.billing.value,
        replyto: order.billing.value,
        message: body
      }, function () {
        var box = $("#order-done");
        $("pre", box).textContent = body;
        $(".addr", box).textContent = order.billing.value;
        reveal(order, box);
      });
    });
  }

  /* Contact form */
  var contact = $("#contact");
  if (contact) {
    if (location.hash === "#enterprise") contact.topic.value = "Enterprise licence";
    contact.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!contact.reportValidity()) return;
      var body = "Topic: " + contact.topic.value + "\nName: " + contact.fullname.value + "\nEmail: " + contact.reply.value +
        "\nCompany: " + contact.company.value + "\n\n" + contact.message.value;
      send(contact, {
        subject: "OpenPronounce: " + contact.topic.value + ", " + contact.fullname.value,
        from_name: "openpronounce.github.io",
        name: contact.fullname.value,
        email: contact.reply.value,
        replyto: contact.reply.value,
        message: body
      }, function () {
        var box = $("#contact-done");
        $(".addr", box).textContent = contact.reply.value;
        reveal(contact, box);
      });
    });
  }
})();
